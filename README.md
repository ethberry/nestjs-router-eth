# NestJS Router ETH (1.x, CommonJS)

Ethereum transport routes blockchain events directly to controllers. The 1.x line is CommonJS for NestJS 11; the
current ESM line for NestJS 12 is on `main`. `@ethberry/nestjs-viem` is the former name of this package.

## Installation

```shell script
$ npm i --save @ethberry/nestjs-router-eth@release-1
```

### Code quality

```sh
docker compose up -d
npm t
```

### How to use:

Import `EthRouterModule` (`EthRouterModule.register(options)` or `registerAsync`, options `IEthRouterModuleOptions`)
and inject `EthRouterService`; the viem client is under the `ETH_CLIENT` token, the account under `ETH_ACCOUNT`. Check
[eth-router.service.spec.ts](src/eth-router.service.spec.ts)

The router never serializes logs or event args to JSON. They hold bigints: an app that logs or stores them as JSON
patches `BigInt.prototype.toJSON` itself. A log that does not fit its entry's ABI is logged with its
`transactionHash:logIndex` and skipped; the `debug` option also logs the decode error.

### Contracts registered from a handler

A handler may call `updateRegistry` for a contract it learns about (a factory's `Deployed` event). The listener then
reads the current range again for that contract, so its events from the same range are delivered, once.

A handler may also call `getPastEvents` itself. That call does not wait for the handlers of its events: they run after
the current handler, one at a time. Its events come in addition to the listener's own, so re-reading a new contract's
range from a handler delivers those events twice; with the above, there is no need to.
