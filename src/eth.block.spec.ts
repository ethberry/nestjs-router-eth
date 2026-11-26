import { jest } from "@jest/globals";
import { Controller, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { Ctx, EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";

import type { IBlockEvent, ILogEvent, IEthModuleOptions } from "./interfaces/index.js";
import { BLOCK_EVENT, ETH_CLIENT } from "./eth.constants.js";
import { EthModule } from "./eth.module.js";
import { EthService } from "./eth.service.js";

@Controller()
class BlockController {
  public readonly seen: Array<{ event: ILogEvent<IBlockEvent>; ctx: IBlockEvent }> = [];

  @EventPattern({ eventName: BLOCK_EVENT })
  public onBlock(@Payload() event: ILogEvent<IBlockEvent>, @Ctx() ctx: IBlockEvent): void {
    this.seen.push({ event, ctx });
  }
}

function moduleOptions(fromBlock: bigint, latency: bigint): IEthModuleOptions {
  return {
    fromBlock,
    latency,
    debug: false,
    cron: CronExpression.EVERY_SECOND,
  };
}

function testModule(options: IEthModuleOptions, controllers: Array<typeof BlockController>) {
  @Module({
    imports: [EthModule.register(options)],
    controllers,
  })
  class TestEthModule {}

  return TestEthModule;
}

async function createModule(
  client: { getBlockNumber: jest.Mock; getLogs: jest.Mock },
  options: IEthModuleOptions,
  controllers: Array<typeof BlockController> = [],
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(), testModule(options, controllers)],
  })
    .overrideProvider(ETH_CLIENT)
    .useValue(client)
    .compile();

  await moduleRef.init();
  moduleRef
    .get(SchedulerRegistry)
    .getCronJobs()
    .forEach(job => job.stop());
  return moduleRef;
}

async function drain(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !ready(); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe("block events", function () {
  const modules: TestingModule[] = [];

  afterEach(async function () {
    await Promise.all(modules.splice(0).map(moduleRef => moduleRef.close()));
  });

  it("should keep the cursor when nobody listens for blocks", async function () {
    const getBlockNumber = jest.fn<(...args: any[]) => any>();
    const options = moduleOptions(4n, 0n);
    const moduleRef = await createModule({ getBlockNumber, getLogs: jest.fn<(...args: any[]) => any>() }, options);
    modules.push(moduleRef);

    await moduleRef.get(EthService).listen();

    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(options.fromBlock).toBe(4n);
  });

  it("should emit the fresh head and keep the cursor while no contract is registered", async function () {
    const getBlockNumber = jest.fn<(...args: any[]) => any>().mockResolvedValueOnce(10n).mockResolvedValueOnce(11n);
    const options = moduleOptions(7n, 2n);
    const moduleRef = await createModule({ getBlockNumber, getLogs: jest.fn<(...args: any[]) => any>() }, options, [
      BlockController,
    ]);
    modules.push(moduleRef);
    const seen = moduleRef.get(BlockController).seen;

    await moduleRef.get(EthService).listen();
    await drain(() => seen.length === 1);

    expect(seen.map(item => item.event.args.blockNumber)).toEqual([10n]);
    expect(seen.map(item => item.event.name)).toEqual([BLOCK_EVENT]);
    expect(seen.map(item => item.ctx.blockNumber)).toEqual([10n]);
    // no contracts registered: nothing was read, the cursor stays for the contracts registered later
    expect(options.fromBlock).toBe(7n);

    await moduleRef.get(EthService).listen();
    await drain(() => seen.length === 2);

    expect(seen.map(item => item.event.args.blockNumber)).toEqual([10n, 11n]);
    expect(seen.map(item => item.event.args.processedBlockNumber)).toEqual([6n, 6n]);
    expect(options.fromBlock).toBe(7n);
  });

  it("should keep scanning contracts when no block handler is registered", async function () {
    const getLogs = jest.fn<(...args: any[]) => any>().mockResolvedValue([]);
    const getBlockNumber = jest.fn<(...args: any[]) => any>().mockResolvedValue(5n);
    const options = moduleOptions(5n, 0n);
    const moduleRef = await createModule({ getBlockNumber, getLogs }, options);
    modules.push(moduleRef);
    const service = moduleRef.get(EthService);
    service.updateRegistry({
      contractType: "ERC20_TOKEN",
      contractAddress: ["0x0000000000000000000000000000000000000001"],
      contractInterface: [],
      eventSignatures: ["Transfer(address,address,uint256)"],
    });

    await service.listen();

    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: 5n,
        toBlock: 5n,
      }),
    );
    expect(options.fromBlock).toBe(6n);
  });
});
