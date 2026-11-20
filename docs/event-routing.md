# Event routing (1.x line)

The 1.x line is released from the `1.x` branch (`manual.yml`, always a patch) under the dist-tag `v1`
(`npm i @ethberry/nestjs-viem@v1`); `latest` belongs to the current major on `main`.

`ViemService` reads contract logs from the chain on a cron and routes each decoded event to the controller methods
whose `@EventPattern({ contractType, eventName })` matches. The 1.x line is CommonJS and finds handlers with
`@golevelup/nestjs-discovery`.

## Registry

- An app registers what to listen to with `updateRegistry(contract)`, where `contract` has `contractType`,
  `contractAddress[]`, `contractInterface` and `eventSignatures[]`. Entries are keyed by `contractType`: a second call
  for the same type adds its addresses and signatures to the existing entry.
- `eventSignatures` are human-readable signatures without the `event` keyword.

## A cycle (`listen`)

1. Nothing happens until the registry or a block handler exists.
2. The head block is read and emitted to block handlers (`BLOCK_EVENT`).
3. `toBlock` = head − `latency` (option); nothing more while `fromBlock` (option) is above it.
4. `getPastEvents(registry, fromBlock, toBlock, chunkSize)` processes the range in passes. A pass is one `eth_getLogs`
   per chunk of `chunkSize` blocks (0 = one request) for the addresses and signatures of the pass.
5. Each log is decoded with every entry of the pass that has the log's address (no event selector check in this
   line: a decode that fails is skipped, and logged with the `debug` option). Matches go to the handlers with the
   pattern `{ contractType: entry.contractType, eventName }`, one event at a time; the pass ends when the handlers of
   all its events have finished.
6. A handler may call `updateRegistry` during a pass (a factory's `Deployed` event registers the new contract). After
   each pass the registry is compared with what this range has fetched, by entry type and address; the next pass
   fetches the range again for the new entry addresses only, and passes repeat until none appears. So every log of a
   registered contract is delivered once, also the logs a new contract emits in the range that registered it. The
   first pass covers the whole registry.
7. `fromBlock` becomes `toBlock + 1`. A cycle that is still running when the cron fires again is skipped.

Limit: a pass is per entry type and address, not per signature. A signature added to an address that this range has
already fetched for that entry type is fetched from the next range on.

## Errors

- `eth_getLogs` failing: logged as an error, the chunk gives no logs.
- A handler that rejects: logged as an error; other handlers of the same event still run.
- No handler for a pattern: logged (`Handler not found for: <route>`).

## Tests

- `viem.registry.spec.ts` (no chain, the client filters prepared logs by the requested addresses, handlers register
  contracts): a contract registered by a handler gets its logs of the same range, once; a chain of registrations takes
  one pass per level; an address registered before the range is fetched once, and the next pass asks only for the new
  address.
- `viem.service.spec.ts`, `viem.block.spec.ts`: `viem.service.spec.ts` runs against a local chain (`JSON_RPC_ADDR` in
  `.env`).
