import { Controller, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { Ctx, EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { encodeEventTopics, pad, parseAbi } from "viem";
import type { Hash } from "viem";

import type { IContractOptions, ILogEvent } from "./interfaces";
import { patchBigInt } from "./utils";
import { VIEM_CLIENT } from "./viem.constants";
import { ViemModule } from "./viem.module";
import { ViemService } from "./viem.service";

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

// the handlers of the app: a factory's Deployed event registers the new contract
@Controller()
class ListenerController {
  public readonly delivered: string[] = [];

  constructor(private readonly viemService: ViemService) {}

  @EventPattern({ contractType: "FACTORY", eventName: "TokenDeployed" })
  public onDeployed(@Payload() { args }: ILogEvent<{ addr: Hash }>): void {
    // decoded addresses come checksummed
    this.delivered.push(`FACTORY:TokenDeployed:${args.addr.toLowerCase()}`);
    this.viemService.updateRegistry(tokenEntry(args.addr));
  }

  @EventPattern({ contractType: "FACTORY", eventName: "FactoryDeployed" })
  public onFactoryDeployed(@Payload() { args }: ILogEvent<{ addr: Hash }>): void {
    this.delivered.push(`FACTORY:FactoryDeployed:${args.addr.toLowerCase()}`);
    this.viemService.updateRegistry(factoryEntry(args.addr));
  }

  @EventPattern({ contractType: "TOKEN", eventName: "Transfer" })
  public onTransfer(@Payload() { args }: ILogEvent<{ tokenId: bigint }>, @Ctx() context: ITestLog): void {
    this.delivered.push(`TOKEN:Transfer:${context.address}:${args.tokenId}`);
  }
}

@Module({
  imports: [ViemModule.register({ fromBlock: 0n, latency: 0n, debug: true, cron: CronExpression.EVERY_SECOND })],
  controllers: [ListenerController],
})
class TestViemModule {}

describe("ViemService.getPastEvents: a contract added to the registry during a range", function () {
  const modules: TestingModule[] = [];

  beforeEach(function () {
    logIndex = 0;
  });

  afterEach(async function () {
    await Promise.all(modules.splice(0).map(moduleRef => moduleRef.close()));
  });

  const run = async (registry: IContractOptions[], logs: ITestLog[]) => {
    const getLogs = jest.fn(({ address }: { address: Hash[] }) =>
      Promise.resolve(logs.filter(l => address.map(a => a.toLowerCase()).includes(l.address.toLowerCase()))),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), TestViemModule],
    })
      .overrideProvider(VIEM_CLIENT)
      .useValue({ getLogs, getBlockNumber: jest.fn() })
      .compile();
    modules.push(moduleRef);
    await moduleRef.init();
    moduleRef
      .get(SchedulerRegistry)
      .getCronJobs()
      .forEach(job => job.stop());

    const service = moduleRef.get(ViemService);
    for (const entry of registry) {
      service.updateRegistry(entry);
    }
    await service.getPastEvents(service.getRegistry(), 0n, 1n);

    return { delivered: moduleRef.get(ListenerController).delivered, getLogs };
  };

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
});
