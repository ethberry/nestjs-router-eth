# @ethberry/nestjs-router-eth

A NestJS transport on viem: reads contract logs block range by block range and routes each decoded event to the controller methods whose `@EventPattern({ contractType, eventName })` matches.

## Installation

```shell script
npm i --save @ethberry/nestjs-router-eth
```

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/schedule`, `rxjs`, `viem`.

## Exports

- `EthRouterModule` (`register` / `registerAsync` with `IEthRouterModuleOptions`), `EthRouterService`.
- `EthRouterService`: `updateRegistry(contract)`, `getRegistry()`, `getPastEvents(registry, fromBlock, toBlock, chunkSize?)`, `getLastBlock()`, `getLastProcessedBlock()`, `listen()` (one cycle; the cron calls it).
- Providers and tokens: `ETH_CLIENT` (a public client), `ETH_ACCOUNT` (from `PRIVATE_KEY`), `CHAIN_PROVIDER` (from `RPC_URL`, `CHAIN_ID`), `ethTransport()`.
- `BLOCK_EVENT`, `waitForConfirmation`, `delay`.
- Types: `IContractOptions`, `ILogEvent`, `IBlockEvent`, `IEthRouterModuleOptions`.

The router never serializes logs or event args to JSON. They hold bigints: an app that logs or stores them as JSON
patches `BigInt.prototype.toJSON` itself.

## Configuration

- `RPC_URL`, `CHAIN_ID` (env, through `ConfigService`): the chain the module's client reads. `PRIVATE_KEY`: the account of `ETH_ACCOUNT`.
- Module options (`IEthRouterModuleOptions`): `fromBlock` (where to start), `latency` (blocks to stay behind the head; 0 on chains that make blocks only on transactions), `chunkSize` (blocks per `eth_getLogs`, 0 = one request), `cron`, `debug` (also log the error of an undecodable log; the log's position is logged always).

## Example

```ts
@Controller()
export class TokenController {
  @EventPattern({ contractType: "ERC20_TOKEN", eventName: "Transfer" })
  public transfer(@Payload() event: ILogEvent<{ from: string; to: string; value: bigint }>, @Ctx() log: Log) {}
}

// once the contract is known (on start, or from a factory's Deployed handler)
ethRouterService.updateRegistry({
  contractType: "ERC20_TOKEN",
  contractAddress: [tokenAddress],
  contractInterface: erc20Abi,
  eventSignatures: ["Transfer(address,address,uint256)"],
});
```

A full working setup is [eth-router.service.spec.ts](src/eth-router.service.spec.ts).

## Writing handlers

- An event comes once per registered entry that has its address and its signature; one address may sit in several entries (a token and its `OWNABLE` entry).
- A handler may call `updateRegistry` for a contract it learns about (a factory's `Deployed` event). The listener then reads the current range again for that contract, so its events from the same range are delivered, once.
- A handler may also call `getPastEvents` itself. That call does not wait for the handlers of its events: they run after the current handler, one at a time. Its events come in addition to the listener's own, so re-reading a new contract's range from a handler delivers those events twice; with the above, there is no need to.
- Native coin transfers have no log and are not seen.
- To resume after a restart, save `getLastProcessedBlock()` (or the block event's `processedBlockNumber`) and start from it + 1: it never names a block whose logs are not handled yet.
- Each event is delivered once; a handler that rejects is logged and skipped. The context (`Log`) has `transactionHash` and `logIndex` to deduplicate if a handler needs to.
- How the cursor moves and what a failure does: [docs/event-routing.md](docs/event-routing.md), "Cursor and failures". A rejected handler does **not** stop the cursor, as in `@ethberry/nestjs-router-solana` and `@ethberry/nestjs-router-ton`.

## Transport

Build your own clients (a wallet client to send transactions) on `ethTransport()`, as the package's client is. It never asks the node `eth_fillTransaction`, which some nodes (Cosmos EVM) answer from a wrong state; viem then fills nonce, gas and fees through the plain RPC methods.

```ts
import { createWalletClient } from "viem";
import { ethTransport } from "@ethberry/nestjs-router-eth";

const wallet = createWalletClient({ account, chain, transport: ethTransport() });
```

## Development

```sh
docker compose up -d
npm t
```
