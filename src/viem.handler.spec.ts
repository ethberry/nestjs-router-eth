import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { encodeEventTopics, parseAbi } from "viem";
import type { Hash } from "viem";

import { patchBigInt } from "./utils/index.js";
import type { IContractOptions, ILogEvent } from "./interfaces/index.js";
import { VIEM_CLIENT } from "./viem.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./viem.module-definition.js";
import { ViemService } from "./viem.service.js";

// as the apps do: logs carry bigints and are logged as JSON
patchBigInt();

// A handler that throws synchronously (not a rejected promise) is logged like a rejection: the other events are still
// delivered and the listener keeps working. No chain: the client returns prepared logs.

const token: Hash = "0x000000000000000000000000000000000000000a";
const account: Hash = "0x0000000000000000000000000000000000000001";
const transfer = "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)";
const tokenAbi = parseAbi([`event ${transfer}`]);
const tokenEntry: IContractOptions = {
  contractType: "TOKEN",
  contractAddress: [token],
  contractInterface: tokenAbi,
  eventSignatures: [transfer],
};

const transferLog = (tokenId: bigint, logIndex: number) => ({
  address: token,
  data: "0x" as Hash,
  topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: account, to: account, tokenId } }),
  blockNumber: 1n,
  logIndex,
});

describe("ViemService with a handler that throws synchronously", function () {
  it("logs the throw, delivers the other events and keeps listening", async function () {
    const delivered: bigint[] = [];
    // the handler of the app: token 1 makes it throw before it returns a promise
    class Listener {
      public onTransfer({ args }: ILogEvent<{ tokenId: bigint }>): Promise<void> {
        if (args.tokenId === 1n) {
          throw new Error("handler threw");
        }
        delivered.push(args.tokenId);
        return Promise.resolve();
      }
    }
    const listener = new Listener();
    const error = jest.fn();
    const logs = [transferLog(1n, 0), transferLog(2n, 1)];

    const module = await Test.createTestingModule({
      providers: [
        ViemService,
        { provide: Logger, useValue: { log: jest.fn(), error, warn: jest.fn() } },
        { provide: VIEM_CLIENT, useValue: { getLogs: () => Promise.resolve(logs) } },
        { provide: DiscoveryService, useValue: { getControllers: () => [{ instance: listener }] } },
        { provide: MetadataScanner, useValue: { getAllMethodNames: () => ["onTransfer"] } },
        {
          provide: Reflector,
          useValue: {
            get: (key: string, handler: unknown) =>
              key === PATTERN_METADATA && handler === Listener.prototype.onTransfer
                ? [{ contractType: "TOKEN", eventName: "Transfer" }]
                : undefined,
          },
        },
        { provide: MODULE_OPTIONS_TOKEN, useValue: { debug: false } },
        { provide: SchedulerRegistry, useValue: {} },
      ],
    }).compile();
    const service = module.get(ViemService);
    service.updateRegistry(tokenEntry);

    await service.getPastEvents(service.getRegistry(), 0n, 1n);
    // the listener still works: the same logs again
    await service.getPastEvents(service.getRegistry(), 0n, 1n);

    expect(delivered).toEqual([2n, 2n]);
    expect(error).toHaveBeenCalledWith(new Error("handler threw"), expect.any(String));
  });
});
