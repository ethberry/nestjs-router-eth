import { Controller, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { createPublicClient, encodeAbiParameters, http } from "viem";
import type { Abi, AbiParameter, Hash } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

import type { ILogEvent, IEthRouterModuleOptions } from "./interfaces/index.js";
import { ETH_CLIENT } from "./eth-router.constants.js";
import { EthRouterModule } from "./eth-router.module.js";
import { EthRouterService } from "./eth-router.service.js";
import { delay } from "./utils/index.js";
import Erc20Contract from "./contracts/ERC20Ownable.json" with { type: "json" };

// The router reads Tron through the node's Ethereum JSON-RPC (`/jsonrpc`) with no Tron code. Against the local TRE node
// (the `tron` service of docker-compose.yml): it makes a block per transaction, and every start is a new chain with new
// funded accounts, read from its admin API. The JSON-RPC has no eth_sendRawTransaction, so the test deploys and mints
// through the native API (`/wallet/*`): the node builds the transaction, the test signs its txID and broadcasts it.

const TRE = "http://127.0.0.1:9190";
const TRANSFER = "Transfer(address,address,uint256)";
const TRC20 = "TRC20_TOKEN";

interface ITransfer {
  from: string;
  to: string;
  value: bigint;
}

interface ITronTransaction {
  txID: string;
}

interface ITransactionInfo {
  id?: string;
  blockNumber: number;
  // 41 + the 20-byte address, hex
  contract_address?: string;
  receipt: { result: string };
}

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${TRE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
};

// the first funded account of this start of the node
const treAccount = async () => {
  const response = await fetch(`${TRE}/admin/accounts-json`);
  const { privateKeys } = (await response.json()) as { privateKeys: string[] };
  const privateKey: Hash = `0x${privateKeys[0]}`;
  const account = privateKeyToAccount(privateKey);
  return { privateKey, account, tronAddress: `41${account.address.slice(2).toLowerCase()}` };
};

type TreAccount = Awaited<ReturnType<typeof treAccount>>;

// signs and broadcasts a transaction the node built, and waits until a block holds it
const send = async (from: TreAccount, transaction: ITronTransaction): Promise<ITransactionInfo> => {
  const signature = await sign({ hash: `0x${transaction.txID}`, privateKey: from.privateKey, to: "hex" });
  await post("/wallet/broadcasttransaction", { ...transaction, signature: [signature.slice(2)] });
  let info = await post<ITransactionInfo>("/wallet/gettransactioninfobyid", { value: transaction.txID });
  while (!info.id) {
    await delay(200);
    info = await post<ITransactionInfo>("/wallet/gettransactioninfobyid", { value: transaction.txID });
  }
  if (info.receipt.result !== "SUCCESS") {
    throw new Error(`Transaction ${transaction.txID} failed: ${info.receipt.result}`);
  }
  return info;
};

// deploys the ERC20 and returns its address as the JSON-RPC shows it (hex without the 41 prefix)
const deployToken = async (from: TreAccount): Promise<Hash> => {
  const constructorInputs = (Erc20Contract.abi as Abi).find(item => item.type === "constructor")!.inputs;
  const transaction = await post<ITronTransaction>("/wallet/deploycontract", {
    owner_address: from.tronAddress,
    abi: JSON.stringify(Erc20Contract.abi),
    bytecode: Erc20Contract.bytecode.slice(2),
    parameter: encodeAbiParameters(constructorInputs as AbiParameter[], ["name", "symbol"]).slice(2),
    fee_limit: 1_000_000_000,
    origin_energy_limit: 10_000_000,
    consume_user_resource_percent: 100,
    name: "ERC20Ownable",
  });
  const info = await send(from, transaction);
  return `0x${info.contract_address!.slice(2)}`;
};

// mints `value` to the account and returns the block of its Transfer log
const mint = async (from: TreAccount, token: Hash, value: bigint): Promise<bigint> => {
  const { transaction } = await post<{ transaction: ITronTransaction }>("/wallet/triggersmartcontract", {
    owner_address: from.tronAddress,
    contract_address: `41${token.slice(2)}`,
    function_selector: "mint(address,uint256)",
    parameter: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [from.account.address, value]).slice(2),
    fee_limit: 1_000_000_000,
  });
  const info = await send(from, transaction);
  return BigInt(info.blockNumber);
};

@Controller()
class TronController {
  public readonly transfers: ITransfer[] = [];

  @EventPattern({ contractType: TRC20, eventName: "Transfer" })
  public onTransfer(@Payload() event: ILogEvent<ITransfer>): void {
    this.transfers.push(event.args);
  }
}

async function createModule(options: IEthRouterModuleOptions): Promise<TestingModule> {
  @Module({ imports: [EthRouterModule.register(options)], controllers: [TronController] })
  class TronModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(), TronModule] })
    .overrideProvider(ETH_CLIENT)
    // the head straight from the node: viem's block-number cache would lag a node that makes a block per transaction
    .useValue(createPublicClient({ transport: http(`${TRE}/jsonrpc`), cacheTime: 0 }))
    .compile();
  await moduleRef.init();
  for (const job of moduleRef.get(SchedulerRegistry).getCronJobs().values()) {
    await job.stop();
  }
  return moduleRef;
}

describe("EthRouterService on Tron", function () {
  let moduleRef: TestingModule | undefined;

  afterEach(async function () {
    await moduleRef?.close();
  });

  it("routes a TRC-20 Transfer read over the JSON-RPC", async function () {
    const value = 1234n;
    const from = await treAccount();
    const token = await deployToken(from);
    const block = await mint(from, token, value);
    // no confirmations: the local node makes no block without a transaction
    const options: IEthRouterModuleOptions = {
      fromBlock: block,
      latency: 0n,
      debug: false,
      cron: CronExpression.EVERY_HOUR,
    };
    moduleRef = await createModule(options);
    const service = moduleRef.get(EthRouterService);
    service.updateRegistry({
      contractType: TRC20,
      contractAddress: [token],
      contractInterface: Erc20Contract.abi as Abi,
      eventSignatures: [TRANSFER],
    });

    await service.listen();

    const transfers = moduleRef.get(TronController).transfers;
    expect(transfers).toHaveLength(1);
    expect(transfers[0].from).toEqual("0x0000000000000000000000000000000000000000");
    expect(transfers[0].to).toEqual(from.account.address);
    expect(transfers[0].value).toEqual(value);
    expect(service.getLastProcessedBlock()).toEqual(block);
  });
});
