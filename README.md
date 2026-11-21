# NestJS Viem Transport

Ethereum transport routes blockchain events directly to controllers

## Installation

```shell script
$ npm i --save @ethberry/nestjs-viem
```

### Code quality

```sh
docker compose up -d
npm t
```

### How to use:

Check [viem.service.spec.ts](src/viem.service.spec.ts)

### Transport

Build your own clients (a wallet client to send transactions) on `viemTransport()`, as the package's client is. It
never asks the node `eth_fillTransaction`, which some nodes (Cosmos EVM) answer from a wrong state; viem then fills
nonce, gas and fees through the plain RPC methods.

```ts
import { createWalletClient } from "viem";
import { viemTransport } from "@ethberry/nestjs-viem";

const wallet = createWalletClient({ account, chain, transport: viemTransport() });
```

### Contracts registered from a handler

A handler may call `updateRegistry` for a contract it learns about (a factory's `Deployed` event). The listener then
reads the current range again for that contract, so its events from the same range are delivered, once.

A handler may also call `getPastEvents` itself. That call does not wait for the handlers of its events: they run after
the current handler, one at a time. Its events come in addition to the listener's own, so re-reading a new contract's
range from a handler delivers those events twice; with the above, there is no need to.
