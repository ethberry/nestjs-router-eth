import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { encodeEventTopics, pad, parseAbi } from "viem";
import type { Hash } from "viem";

import { patchBigInt } from "./utils/index.js";
import type { IContractOptions, ILogEvent } from "./interfaces/index.js";
import { VIEM_CLIENT } from "./viem.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./viem.module-definition.js";
import { ViemService } from "./viem.service.js";

// as the apps do: logs carry bigints and are logged as JSON
patchBigInt();

// A handler can add a contract to the registry while a range is processed (a factory's Deployed event adds the new
// contract). Every log of a registered address in that range is delivered once, also the logs of the address added
// during it. No chain: the client returns prepared logs filtered by the requested addresses, like eth_getLogs.

const factory: Hash = "0x0000000000000000000000000000000000000f00";
const tokenA: Hash = "0x000000000000000000000000000000000000000a";
const tokenB: Hash = "0x000000000000000000000000000000000000000b";
const account: Hash = "0x0000000000000000000000000000000000000001";

const deployed = "TokenDeployed(address indexed addr)";
const factoryDeployed = "FactoryDeployed(address indexed addr)";
const transfer = "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)";
const factoryAbi = parseAbi([`event ${deployed}`, `event ${factoryDeployed}`]);
const tokenAbi = parseAbi([`event ${transfer}`]);

const factoryEntry = (address: Hash = factory): IContractOptions => ({
  contractType: "FACTORY",
  contractAddress: [address],
  contractInterface: factoryAbi,
  eventSignatures: [deployed, factoryDeployed],
});
const tokenEntry = (address: Hash): IContractOptions => ({
  contractType: "TOKEN",
  contractAddress: [address],
  contractInterface: tokenAbi,
  eventSignatures: [transfer],
});

interface ITestLog {
  address: Hash;
  data: Hash;
  topics: ReturnType<typeof encodeEventTopics>;
  blockNumber: bigint;
  logIndex: number;
}

let logIndex = 0;
const log = (address: Hash, topics: ReturnType<typeof encodeEventTopics>): ITestLog => ({
  address,
  data: "0x",
  topics,
  blockNumber: 1n,
  logIndex: logIndex++,
});
const deployedLog = (addr: Hash) =>
  log(factory, encodeEventTopics({ abi: factoryAbi, eventName: "TokenDeployed", args: { addr } }));
const factoryDeployedLog = (addr: Hash) =>
  log(factory, encodeEventTopics({ abi: factoryAbi, eventName: "FactoryDeployed", args: { addr } }));
const transferLog = (address: Hash, tokenId: bigint) =>
  log(
    address,
    encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: account, to: account, tokenId } }),
  );

// rereadOnDeploy: the Deployed handler also calls getPastEvents for the new token itself, as an app may do
const run = async (registry: IContractOptions[], logs: ITestLog[], rereadOnDeploy = false) => {
  const delivered: string[] = [];
  // set after the module compiles; the handlers run only after that
  const ref: { service?: ViemService } = {};

  // the handlers of the app: the factory's Deployed event registers the new token
  class Listener {
    public async onDeployed({ args }: ILogEvent<{ addr: Hash }>) {
      // decoded addresses come checksummed
      delivered.push(`FACTORY:TokenDeployed:${args.addr.toLowerCase()}`);
      ref.service!.updateRegistry(tokenEntry(args.addr));
      if (rereadOnDeploy) {
        await ref.service!.getPastEvents([tokenEntry(args.addr)], 0n, 1n);
      }
    }

    public onFactoryDeployed({ args }: ILogEvent<{ addr: Hash }>) {
      delivered.push(`FACTORY:FactoryDeployed:${args.addr.toLowerCase()}`);
      ref.service!.updateRegistry(factoryEntry(args.addr));
    }

    public onTransfer({ args }: ILogEvent<{ tokenId: bigint }>, context: ITestLog) {
      delivered.push(`TOKEN:Transfer:${context.address}:${args.tokenId}`);
    }
  }
  const patterns: Record<string, Array<Record<string, string>>> = {
    onDeployed: [{ contractType: "FACTORY", eventName: "TokenDeployed" }],
    onFactoryDeployed: [{ contractType: "FACTORY", eventName: "FactoryDeployed" }],
    onTransfer: [{ contractType: "TOKEN", eventName: "Transfer" }],
  };
  const listener = new Listener();

  const getLogs = jest.fn(({ address }: { address: Hash[] }) =>
    Promise.resolve(logs.filter(l => address.map(a => a.toLowerCase()).includes(l.address.toLowerCase()))),
  );

  const module = await Test.createTestingModule({
    providers: [
      ViemService,
      { provide: Logger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      { provide: VIEM_CLIENT, useValue: { getLogs } },
      { provide: DiscoveryService, useValue: { getControllers: () => [{ instance: listener }] } },
      { provide: MetadataScanner, useValue: { getAllMethodNames: () => Object.keys(patterns) } },
      {
        provide: Reflector,
        useValue: {
          get: (key: string, handler: (...args: unknown[]) => unknown) =>
            key === PATTERN_METADATA
              ? Object.entries(patterns).find(([name]) => Listener.prototype[name as keyof Listener] === handler)?.[1]
              : undefined,
        },
      },
      { provide: MODULE_OPTIONS_TOKEN, useValue: { debug: true } },
      { provide: SchedulerRegistry, useValue: {} },
    ],
  }).compile();
  const service = module.get(ViemService);
  ref.service = service;

  for (const entry of registry) {
    service.updateRegistry(entry);
  }
  await service.getPastEvents(service.getRegistry(), 0n, 1n);

  return { delivered, getLogs };
};

describe("ViemService.getPastEvents: a contract added to the registry during a range", function () {
  beforeEach(function () {
    logIndex = 0;
  });

  it("delivers the logs of a contract that a handler registers in the same range, once", async function () {
    const { delivered } = await run([factoryEntry()], [deployedLog(tokenA), transferLog(tokenA, 1n)]);

    expect(delivered).toEqual([`FACTORY:TokenDeployed:${tokenA}`, `TOKEN:Transfer:${tokenA}:1`]);
  });

  it("repeats until no new contract appears: a contract added on the second pass is fetched too", async function () {
    // the factory deploys a second factory, the second factory deploys tokenB, tokenB transfers: three passes
    const factory2: Hash = pad("0xf02", { size: 20 });
    const { delivered, getLogs } = await run(
      [factoryEntry()],
      [factoryDeployedLog(factory2), { ...deployedLog(tokenB), address: factory2 }, transferLog(tokenB, 2n)],
    );

    expect(delivered).toEqual([
      `FACTORY:FactoryDeployed:${factory2}`,
      `FACTORY:TokenDeployed:${tokenB}`,
      `TOKEN:Transfer:${tokenB}:2`,
    ]);
    expect(getLogs).toHaveBeenCalledTimes(3);
  });

  it("an address that was registered before the range is fetched once", async function () {
    const { delivered, getLogs } = await run(
      [factoryEntry(), tokenEntry(tokenA)],
      [transferLog(tokenA, 1n), deployedLog(tokenB), transferLog(tokenB, 2n)],
    );

    expect(delivered).toEqual([
      `TOKEN:Transfer:${tokenA}:1`,
      `FACTORY:TokenDeployed:${tokenB}`,
      `TOKEN:Transfer:${tokenB}:2`,
    ]);
    // the first pass for the registry, the second only for the added tokenB
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[1][0].address).toEqual([tokenB]);
  });

  it("a handler that calls getPastEvents itself does not block the listener", async function () {
    // the nested call does not wait for handlers (its events queue behind the running one); the range's own pass for
    // the new token delivers its logs again, as the app asked for them twice
    const { delivered } = await run([factoryEntry()], [deployedLog(tokenA), transferLog(tokenA, 1n)], true);

    expect(delivered).toEqual([
      `FACTORY:TokenDeployed:${tokenA}`,
      `TOKEN:Transfer:${tokenA}:1`,
      `TOKEN:Transfer:${tokenA}:1`,
    ]);
  });
});
