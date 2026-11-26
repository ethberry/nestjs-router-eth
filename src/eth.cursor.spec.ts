import { Controller, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { Test, TestingModule } from "@nestjs/testing";
import { config } from "dotenv";
import { Abi } from "abitype";
import type { Hash, PublicClient } from "viem";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { patchBigInt } from "./utils/index.js";
import type { IBlockEvent, ILogEvent, IEthModuleOptions } from "./interfaces/index.js";
import { BLOCK_EVENT, ETH_CLIENT } from "./eth.constants.js";
import { EthModule } from "./eth.module.js";
import { EthService } from "./eth.service.js";
import Erc20Contract from "./contracts/ERC20Ownable.json" with { type: "json" };

// The cursor (`fromBlock`, `getLastProcessedBlock`, the block event's `processedBlockNumber`) never passes a log that
// was not read and handled. Against the local chain (`JSON_RPC_ADDR`), cron off, `listen()` called by the test; RPC
// failures are injected by a client that wraps the real one.

config();
patchBigInt();

const rpc = process.env.JSON_RPC_ADDR;
const chain = defineChain({
  id: 10000,
  name: "Besu",
  nativeCurrency: { name: "Besu", symbol: "BESU", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const walletClient = createWalletClient({ chain, transport: http(rpc) });
const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hash);
const TRANSFER = "Transfer(address,address,uint256)";
const ERC20 = "ERC20_TOKEN";

interface ITransfer {
  from: string;
  to: string;
  value: bigint;
}

// the real client; the next getBlockNumber or getLogs can be made to fail once
class FlakyClient {
  public failHead = false;
  public failLogs = false;

  public getBlockNumber(): Promise<bigint> {
    if (this.failHead) {
      this.failHead = false;
      return Promise.reject(new Error("head unavailable"));
    }
    return publicClient.getBlockNumber();
  }

  public getLogs(args: Parameters<PublicClient["getLogs"]>[0]) {
    if (this.failLogs) {
      this.failLogs = false;
      return Promise.reject(new Error("eth_getLogs failed"));
    }
    return publicClient.getLogs(args);
  }
}

@Controller()
class CursorController {
  public readonly values: bigint[] = [];
  public readonly blocks: IBlockEvent[] = [];
  // getLastProcessedBlock() seen by the transfer handler, while its log is being handled
  public readonly processedDuringHandler: bigint[] = [];
  public rejectNext = false;

  constructor(private readonly ethService: EthService) {}

  @EventPattern({ contractType: ERC20, eventName: "Transfer" })
  public onTransfer(@Payload() event: ILogEvent<ITransfer>): Promise<void> {
    this.processedDuringHandler.push(this.ethService.getLastProcessedBlock());
    if (this.rejectNext) {
      this.rejectNext = false;
      return Promise.reject(new Error("message bus down"));
    }
    this.values.push(event.args.value);
    return Promise.resolve();
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public onBlock(@Payload() event: ILogEvent<IBlockEvent>): void {
    this.blocks.push(event.args);
  }
}

async function deployToken(): Promise<Hash> {
  const hash = await walletClient.deployContract({
    account,
    abi: Erc20Contract.abi,
    bytecode: Erc20Contract.bytecode as Hash,
    args: ["name", "symbol"],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

// mints `value` and returns the block of its Transfer log
async function mint(token: Hash, value: bigint): Promise<bigint> {
  const hash = await walletClient.writeContract({
    account,
    chain,
    address: token,
    abi: Erc20Contract.abi,
    functionName: "mint",
    args: [account.address, value],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.blockNumber;
}

async function createModule(client: FlakyClient, options: IEthModuleOptions): Promise<TestingModule> {
  @Module({ imports: [EthModule.register(options)], controllers: [CursorController] })
  class CursorModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(), CursorModule] })
    .overrideProvider(ETH_CLIENT)
    .useValue(client)
    .compile();
  await moduleRef.init();
  moduleRef
    .get(SchedulerRegistry)
    .getCronJobs()
    .forEach(job => {
      void job.stop();
    });
  return moduleRef;
}

const options = (fromBlock: bigint): IEthModuleOptions => ({
  fromBlock,
  latency: 0n,
  debug: false,
  cron: CronExpression.EVERY_HOUR,
});

describe("EthService cursor", function () {
  let token: Hash;
  let client: FlakyClient;
  let moduleRef: TestingModule;

  beforeAll(async function () {
    token = await deployToken();
  });

  afterEach(async function () {
    await moduleRef?.close();
  });

  const register = (service: EthService) =>
    service.updateRegistry({
      contractType: ERC20,
      contractAddress: [token],
      contractInterface: Erc20Contract.abi as Abi,
      eventSignatures: [TRANSFER],
    });

  // a module whose cursor starts at the block of a fresh mint of `value`
  async function start(value: bigint, withRegistry = true) {
    const block = await mint(token, value);
    client = new FlakyClient();
    const moduleOptions = options(block);
    moduleRef = await createModule(client, moduleOptions);
    const service = moduleRef.get(EthService);
    if (withRegistry) {
      register(service);
    }
    return { block, moduleOptions, service, controller: moduleRef.get(CursorController) };
  }

  it("delivers a log of a block reached while the registry was empty", async function () {
    const value = 1001n;
    const { block, moduleOptions, service, controller } = await start(value, false);

    await service.listen();
    const cursorWhileEmpty = moduleOptions.fromBlock;
    register(service);
    await service.listen();

    expect(cursorWhileEmpty).toEqual(block);
    expect(controller.values).toEqual([value]);
  });

  it("reads the range again after eth_getLogs failed", async function () {
    const value = 1002n;
    const { block, moduleOptions, service, controller } = await start(value);

    client.failLogs = true;
    await service.listen();
    const cursorAfterFailure = moduleOptions.fromBlock;
    const valuesAfterFailure = [...controller.values];
    await service.listen();

    expect(cursorAfterFailure).toEqual(block);
    expect(valuesAfterFailure).toEqual([]);
    expect(controller.values).toEqual([value]);
  });

  it("delivers each log once: a rejected handler is logged and the cursor moves on", async function () {
    const value = 1006n;
    const { block, moduleOptions, service, controller } = await start(value);

    controller.rejectNext = true;
    await service.listen();
    const cursorAfterRejection = moduleOptions.fromBlock;
    await service.listen();

    expect(cursorAfterRejection > block).toEqual(true);
    expect(controller.processedDuringHandler).toHaveLength(1);
    expect(controller.values).toEqual([]);
  });

  it("never names a block whose logs are not handled as processed", async function () {
    const value = 1004n;
    const { block, service, controller } = await start(value);

    await service.listen();
    const processedAfterTick = service.getLastProcessedBlock();
    await service.listen();

    // while the log of `block` is handled, and in the block event of that tick, the processed block is before it
    expect(controller.processedDuringHandler).toEqual([block - 1n]);
    expect(controller.blocks[0].processedBlockNumber).toEqual(block - 1n);
    // after the tick, the block is processed, and the next block event says so
    expect(processedAfterTick >= block).toEqual(true);
    expect(controller.blocks[1].processedBlockNumber).toEqual(processedAfterTick);
    expect(controller.values).toEqual([value]);
  });

  it("skips the tick when the head cannot be read", async function () {
    const value = 1005n;
    const { block, moduleOptions, service, controller } = await start(value);

    client.failHead = true;
    await service.listen();

    expect(controller.blocks).toEqual([]);
    expect(controller.values).toEqual([]);
    expect(moduleOptions.fromBlock).toEqual(block);
  });
});
