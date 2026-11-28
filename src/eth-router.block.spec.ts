import { jest } from "@jest/globals";
import { Controller, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { Ctx, EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { encodeEventTopics, parseAbi } from "viem";
import type { Hash } from "viem";

import type { IBlockEvent, ILogEvent, IEthRouterModuleOptions } from "./interfaces/index.js";
import { BLOCK_EVENT, ETH_CLIENT } from "./eth-router.constants.js";
import { EthRouterModule } from "./eth-router.module.js";
import { EthRouterService } from "./eth-router.service.js";

// The block event comes after a range is done (its logs read, their handlers finished) and names the range's last
// block. No chain: a stub client gives the head and the logs.

const TOKEN = "TOKEN";
const token: Hash = "0x000000000000000000000000000000000000000a";
const account: Hash = "0x0000000000000000000000000000000000000001";
const transfer = "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)";
const tokenAbi = parseAbi([`event ${transfer}`]);

// a Transfer of `tokenId` in `blockNumber`
const transferLog = (tokenId: bigint, blockNumber: bigint) => ({
  address: token,
  data: "0x",
  topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: account, to: account, tokenId } }),
  blockNumber,
  transactionHash: "0x01",
  logIndex: 0,
});

@Controller()
class RangeController {
  // what the handlers saw, in order
  public readonly journal: string[] = [];
  public readonly blocks: Array<{ args: IBlockEvent; ctx: IBlockEvent; lastProcessed: bigint }> = [];
  public rejectBlock = false;

  constructor(private readonly ethRouterService: EthRouterService) {}

  @EventPattern({ contractType: TOKEN, eventName: "Transfer" })
  public onTransfer(@Payload() event: ILogEvent<{ tokenId: bigint }>): void {
    this.journal.push(`Transfer ${event.args.tokenId}`);
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public onBlock(@Payload() event: ILogEvent<IBlockEvent>, @Ctx() ctx: IBlockEvent): Promise<void> {
    this.journal.push(`block ${event.args.processedBlockNumber}`);
    this.blocks.push({ args: event.args, ctx, lastProcessed: this.ethRouterService.getLastProcessedBlock() });
    return this.rejectBlock ? Promise.reject(new Error("cursor not saved")) : Promise.resolve();
  }
}

function moduleOptions(fromBlock: bigint, latency: bigint): IEthRouterModuleOptions {
  return {
    fromBlock,
    latency,
    debug: false,
    cron: CronExpression.EVERY_SECOND,
  };
}

function testModule(options: IEthRouterModuleOptions, controllers: Array<typeof RangeController>) {
  @Module({
    imports: [EthRouterModule.register(options)],
    controllers,
  })
  class TestEthModule {}

  return TestEthModule;
}

interface IStubClient {
  getBlockNumber: jest.Mock<() => Promise<bigint>>;
  getLogs: jest.Mock<() => Promise<Array<ReturnType<typeof transferLog>>>>;
}

const stubClient = (head: bigint, logs: Array<ReturnType<typeof transferLog>> = []): IStubClient => ({
  getBlockNumber: jest.fn<() => Promise<bigint>>().mockResolvedValue(head),
  getLogs: jest.fn<() => Promise<Array<ReturnType<typeof transferLog>>>>().mockResolvedValue(logs),
});

async function createModule(
  client: IStubClient,
  options: IEthRouterModuleOptions,
  controllers: Array<typeof RangeController> = [RangeController],
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(), testModule(options, controllers)],
  })
    .overrideProvider(ETH_CLIENT)
    .useValue(client)
    .compile();

  await moduleRef.init();
  for (const job of moduleRef.get(SchedulerRegistry).getCronJobs().values()) {
    await job.stop();
  }
  return moduleRef;
}

const registerToken = (service: EthRouterService) =>
  service.updateRegistry({
    contractType: TOKEN,
    contractAddress: [token],
    contractInterface: tokenAbi,
    eventSignatures: [transfer],
  });

describe("block events", function () {
  const modules: TestingModule[] = [];

  afterEach(async function () {
    await Promise.all(modules.splice(0).map(moduleRef => moduleRef.close()));
  });

  it("reads nothing and sends no block event while no contract is registered", async function () {
    const client = stubClient(10n);
    const options = moduleOptions(7n, 2n);
    const moduleRef = await createModule(client, options);
    modules.push(moduleRef);

    await moduleRef.get(EthRouterService).listen();

    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(moduleRef.get(RangeController).journal).toEqual([]);
    // the cursor waits for the contracts registered later
    expect(options.fromBlock).toBe(7n);
  });

  it("sends the block event after the range's handlers, with the range's last block", async function () {
    const head = 10n;
    const latency = 2n;
    const client = stubClient(head, [transferLog(1n, 8n)]);
    const options = moduleOptions(7n, latency);
    const moduleRef = await createModule(client, options);
    modules.push(moduleRef);
    const service = moduleRef.get(EthRouterService);
    const controller = moduleRef.get(RangeController);
    registerToken(service);

    await service.listen();

    const lastOfRange = head - latency;
    expect(controller.journal).toEqual(["Transfer 1", `block ${lastOfRange}`]);
    expect(controller.blocks[0].args).toEqual({ blockNumber: head, processedBlockNumber: lastOfRange });
    expect(controller.blocks[0].ctx).toEqual({ blockNumber: head, processedBlockNumber: lastOfRange });
    expect(controller.blocks[0].lastProcessed).toEqual(lastOfRange);
    expect(options.fromBlock).toBe(lastOfRange + 1n);
  });

  it.each([
    ["waiting for confirmation", () => stubClient(8n)],
    [
      "eth_getLogs failed",
      () => {
        const client = stubClient(10n);
        client.getLogs.mockRejectedValue(new Error("429 Too Many Requests"));
        return client;
      },
    ],
    [
      "the head could not be read",
      () => {
        const client = stubClient(10n);
        client.getBlockNumber.mockRejectedValue(new Error("node down"));
        return client;
      },
    ],
  ])("sends no block event and keeps the cursor when %s", async function (_, makeClient) {
    const options = moduleOptions(7n, 2n);
    const moduleRef = await createModule(makeClient(), options);
    modules.push(moduleRef);
    registerToken(moduleRef.get(EthRouterService));

    await moduleRef.get(EthRouterService).listen();

    expect(moduleRef.get(RangeController).journal).toEqual([]);
    expect(options.fromBlock).toBe(7n);
  });

  it("goes on after a block handler rejects", async function () {
    const client = stubClient(10n);
    client.getBlockNumber.mockResolvedValueOnce(10n).mockResolvedValueOnce(11n);
    const options = moduleOptions(7n, 2n);
    const moduleRef = await createModule(client, options);
    modules.push(moduleRef);
    const service = moduleRef.get(EthRouterService);
    const controller = moduleRef.get(RangeController);
    registerToken(service);

    controller.rejectBlock = true;
    await service.listen();
    controller.rejectBlock = false;
    await service.listen();

    expect(controller.journal).toEqual(["block 8", "block 9"]);
    expect(options.fromBlock).toBe(10n);
  });

  it("reads the contracts when no block handler is registered", async function () {
    const client = stubClient(5n);
    const options = moduleOptions(5n, 0n);
    const moduleRef = await createModule(client, options, []);
    modules.push(moduleRef);
    const service = moduleRef.get(EthRouterService);
    registerToken(service);

    await service.listen();

    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: 5n,
        toBlock: 5n,
      }),
    );
    expect(options.fromBlock).toBe(6n);
  });
});
