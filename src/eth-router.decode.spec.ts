import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { encodeEventTopics, parseAbi } from "viem";
import type { Hash } from "viem";

import type { IContractOptions } from "./interfaces/index.js";
import { ETH_CLIENT } from "./eth-router.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./eth-router.module-definition.js";
import { EthRouterService } from "./eth-router.service.js";

// No BigInt JSON patch here or in any other spec: logs and decoded args carry bigints, and the router must not
// serialize them (an app may or may not patch BigInt.prototype.toJSON).

// Which registry entry decodes a log. One address can sit in several entries (a token entry and its access-control or
// ownable entry, as framework registers them): a log is decoded with every entry that has its address and its event
// selector, and with no other entry. No chain: the client returns prepared logs; no controllers: a routed event ends
// in "Handler not found for: <route>", which shows the route.

const token: Hash = "0x0000000000000000000000000000000000000abc";
const other: Hash = "0x0000000000000000000000000000000000000def";
const role: Hash = "0x0000000000000000000000000000000000000000000000000000000000000000";
const account: Hash = "0x0000000000000000000000000000000000000001";

const transfer = "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)";
const roleGranted = "RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)";
const ownershipTransferred = "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)";

const tokenAbi = parseAbi([`event ${transfer}`, `event ${ownershipTransferred}`]);
const accessAbi = parseAbi([`event ${roleGranted}`]);
const ownableAbi = parseAbi([`event ${ownershipTransferred}`]);

const erc721: IContractOptions = {
  contractType: "ERC721",
  contractAddress: [token],
  contractInterface: tokenAbi,
  eventSignatures: [transfer, ownershipTransferred],
};
const accessControl: IContractOptions = {
  contractType: "ACCESS_CONTROL",
  contractAddress: [token],
  contractInterface: accessAbi,
  eventSignatures: [roleGranted],
};
const ownable: IContractOptions = {
  contractType: "OWNABLE",
  contractAddress: [token],
  contractInterface: ownableAbi,
  eventSignatures: [ownershipTransferred],
};

const log = (address: string, topics: ReturnType<typeof encodeEventTopics>) => ({
  address,
  data: "0x",
  topics,
  blockNumber: 1n,
  transactionHash: role,
  logIndex: 0,
});

const roleGrantedTopics = encodeEventTopics({
  abi: accessAbi,
  eventName: "RoleGranted",
  args: { role, account, sender: account },
});
const ownershipTopics = encodeEventTopics({
  abi: ownableAbi,
  eventName: "OwnershipTransferred",
  args: { previousOwner: account, newOwner: account },
});

const route = (contractType: string, eventName: string) =>
  `Handler not found for: ${JSON.stringify({ contractType, eventName })}`;

const run = async (registry: IContractOptions[], logs: unknown[], debug = true) => {
  const logger = { log: jest.fn<(message: unknown, context?: string) => void>(), error: jest.fn(), warn: jest.fn() };
  const module = await Test.createTestingModule({
    providers: [
      EthRouterService,
      { provide: Logger, useValue: logger },
      { provide: ETH_CLIENT, useValue: { getLogs: () => Promise.resolve(logs) } },
      { provide: DiscoveryService, useValue: { getControllers: () => [] } },
      { provide: MetadataScanner, useValue: {} },
      { provide: Reflector, useValue: {} },
      { provide: MODULE_OPTIONS_TOKEN, useValue: { debug } },
      { provide: SchedulerRegistry, useValue: {} },
    ],
  }).compile();
  await module.get(EthRouterService).getPastEvents(registry, 0n, 1n);
  const messages = () => logger.log.mock.calls.map(([message]) => String(message));
  // routing runs on the service's subject after getPastEvents returns: wait for the expected routes
  const routed = async (expected: string[]) => {
    await new Promise<void>(resolve => {
      const check = () => (expected.every(r => messages().includes(r)) ? resolve() : setImmediate(check));
      check();
    });
    return messages().filter(m => m.startsWith("Handler not found for:"));
  };
  return { logger, messages, routed };
};

describe("EthRouterService.getPastEvents: which entry decodes a log", function () {
  it("runs without a BigInt JSON patch", function () {
    expect("toJSON" in BigInt.prototype).toBe(false);
  });

  it.each([true, false])("routes an event whose args hold a bigint (debug %s)", async function (debug) {
    const transferTopics = encodeEventTopics({
      abi: tokenAbi,
      eventName: "Transfer",
      args: { from: account, to: account, tokenId: 7n },
    });
    // getPastEvents returns after the handlers of the range have finished: the route is logged by then
    const { logger, messages } = await run([erc721], [log(token, transferTopics)], debug);

    expect(messages()).toContain(route("ERC721", "Transfer"));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("one address, two entries: the log goes only to the entry with its event, no decode error", async function () {
    const { logger, routed } = await run([erc721, accessControl], [log(token, roleGrantedTopics)]);

    expect(await routed([route("ACCESS_CONTROL", "RoleGranted")])).toEqual([route("ACCESS_CONTROL", "RoleGranted")]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("an event that two entries on the address both have is decoded by both and routed to both", async function () {
    const expected = [route("ERC721", "OwnershipTransferred"), route("OWNABLE", "OwnershipTransferred")];
    const { logger, routed } = await run([erc721, ownable, accessControl], [log(token, ownershipTopics)]);

    expect((await routed(expected)).sort()).toEqual(expected.sort());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("an entry with the event but not the address does not decode the log", async function () {
    const elsewhere: IContractOptions = { ...accessControl, contractType: "ELSEWHERE", contractAddress: [other] };
    const { logger, routed } = await run([elsewhere, accessControl], [log(token, roleGrantedTopics)]);

    expect(await routed([route("ACCESS_CONTROL", "RoleGranted")])).toEqual([route("ACCESS_CONTROL", "RoleGranted")]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("matches the address in any letter case", async function () {
    const upper: IContractOptions = { ...accessControl, contractAddress: [token.toUpperCase().replace("0X", "0x")] };
    const { routed } = await run([upper], [log(token, roleGrantedTopics)]);

    expect(await routed([route("ACCESS_CONTROL", "RoleGranted")])).toEqual([route("ACCESS_CONTROL", "RoleGranted")]);
  });

  it("a log of an event no entry on the address registered is not decoded and not reported", async function () {
    const { logger, messages } = await run([erc721], [log(token, roleGrantedTopics)]);

    expect(logger.error).not.toHaveBeenCalled();
    expect(messages().some(m => m.startsWith("Handler not found for:"))).toBe(false);
  });

  // a real decode error: the signature is registered, the ABI lacks the event
  const broken: IContractOptions = { ...accessControl, contractInterface: tokenAbi };
  const decodeError = `Can't decode ACCESS_CONTROL log ${role}:0`;

  it("a decode error is logged with the log's position and the log is skipped, also with debug off", async function () {
    const { logger, messages } = await run([broken], [log(token, roleGrantedTopics)], false);

    expect(logger.error.mock.calls).toEqual([[decodeError, expect.any(String)]]);
    expect(messages().some(m => m.startsWith("Handler not found for:"))).toBe(false);
  });

  it("with debug on, a decode error also logs the error itself", async function () {
    const { logger } = await run([broken], [log(token, roleGrantedTopics)], true);

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[0]).toEqual([decodeError, expect.any(String)]);
    expect(logger.error.mock.calls[1][0]).toBeInstanceOf(Error);
  });

  it("a decode error does not stop the logs after it", async function () {
    const { logger, messages } = await run(
      [broken, erc721],
      [log(token, roleGrantedTopics), log(token, ownershipTopics)],
      false,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(messages()).toContain(route("ERC721", "OwnershipTransferred"));
  });
});
