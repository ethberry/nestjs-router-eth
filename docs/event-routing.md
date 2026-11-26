# Event routing (1.x line)

The 1.x line is released from the `1.x` branch (`manual.yml`, a patch or a minor) under the dist-tag
`release-1` (`npm i @ethberry/nestjs-router-eth@release-1`); `latest` belongs to the current major on `main`. A
dist-tag must not be a semver range, so `v1` or `1.x` are refused by npm. Up to 1.0.8 the package was
`@ethberry/nestjs-viem`; 1.1.0 is the first release under the new name.

The line carries the fixes of `main` that apply to Ethereum, without the ESM build and without `viemTransport` (the
Cosmos EVM workaround, ADR 0001 on `main`): the client uses viem's plain `http()`.

`EthService` reads contract logs from the chain on a cron and routes each decoded event to the controller methods
whose `@EventPattern({ contractType, eventName })` matches. The 1.x line is CommonJS for NestJS 11 and finds handlers
with NestJS's own `DiscoveryService`.

## Registry

- An app registers what to listen to with `updateRegistry(contract)`, where `contract` has `contractType`,
  `contractAddress[]`, `contractInterface` and `eventSignatures[]`. Entries are keyed by `contractType`: a second call
  for the same type adds its addresses and signatures to the existing entry.
- One address may sit in several entries (a token entry, its `ACCESS_CONTROL` or `OWNABLE` entry, a diamond's facets).
- `eventSignatures` are human-readable signatures without the `event` keyword
  (`Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`).

## A cycle (`listen`)

1. Nothing happens until the registry or a block handler exists.
2. The head block is read. If that RPC call fails, the error is logged and the cycle ends: no block event, the cursor
   stays.
3. The block event (`BLOCK_EVENT`) goes to the block handlers with `blockNumber` (the head) and `processedBlockNumber`
   (`getLastProcessedBlock()`, below). The cycle waits for the block handlers before it reads logs.
4. `toBlock` = head − `latency` (option). Nothing more while the registry is empty (the app registers its contracts
   later; the cursor waits for them) or while `fromBlock` (option) is above `toBlock`.
5. `getPastEvents(registry, fromBlock, toBlock, chunkSize)` processes the range in passes. A pass is one `eth_getLogs`
   per chunk for the addresses and signatures of the pass. The chunks are consecutive inclusive ranges of at most
   `chunkSize` blocks (`[from, from + chunkSize − 1]`, …, the last one ending at `toBlock`); without `chunkSize`, one
   request.
6. Each log is decoded with each entry that has the log's address **and** whose `eventSignatures` contain the log's
   selector (`topics[0]`, `toEventSelector` of each signature, computed once per pass). So a log of one entry is never
   decoded with another entry's ABI that shares the address. Matches go to the handlers with the pattern
   `{ contractType: entry.contractType, eventName }` through one queue, one event at a time (block events too). The
   pass ends when the queue is empty: the handlers of its events, and of every event queued meanwhile, have finished.
7. A handler may call `updateRegistry` during a pass (a factory's `Deployed` event registers the new contract). After
   each pass the registry is compared with what this range has fetched, by entry type, address and signature; the
   next pass fetches the range again for what is new only, and passes repeat until nothing new appears. So every log
   of a registered contract is delivered once, also the logs a new contract emits in the range that registered it
   (constructor events, the first mint, a call right after the deploy). The first pass covers the whole registry.
8. `fromBlock` becomes `toBlock + 1`. A cycle that is still running when the cron fires again is skipped.

## `getPastEvents` from a handler

A handler may call `getPastEvents` itself (a handler runs inside an `AsyncLocalStorage` context that marks it). Such a
call fetches and decodes its range once, queues the events behind the running handler and returns without waiting for
them: waiting would block the queue it is part of. There are no extra passes for contracts registered by those
events; the listen cycle's own pass picks them up. Its events are delivered in addition to the listen cycle's, so a
handler that re-reads a range a new contract is already fetched for gets those logs twice. Since the cycle delivers
the logs of a contract registered during the range, a handler does not need to re-read them.

## Cursor and failures

- The cursor is `fromBlock` in memory. It moves to `toBlock + 1` only after every log of the range was fetched and
  every handler of its events has finished.
- Each event is delivered once. A handler that rejects (or throws synchronously) is logged and does not hold the
  cursor: what to do with an event it could not handle is the handler's decision. The handler's context (the viem
  `Log`) carries `blockHash`, `transactionHash` and `logIndex`, which identify the event for deduplication.
- `getLastProcessedBlock()` is the last block whose logs and handlers have all completed: `fromBlock − 1`, before the
  first range the block before the start block, and `0n` when the start block is 0. It is safe to save as a cursor at
  any time, also during a cycle (a shutdown hook); resume from it + 1.
- The block event fires at the start of a cycle: `blockNumber` is the head, not a "range done" signal;
  `processedBlockNumber` is the safe cursor.

## Errors

- `eth_getLogs` failing (a rate limit, a range too large, the node down): the error is logged and the cycle ends; the
  cursor stays and the next cycle reads the same range again. Events of an earlier pass of that range were delivered
  already and come again then.
- The head (`eth_blockNumber`) failing: logged, the cycle is skipped. `getLastBlock()` rejects with the RPC error.
- A decode that fails although the selector matched (a wrong ABI for the registered signature): with the `debug`
  option, the log and the error are logged; without it, skipped silently.
- A handler that rejects, or throws synchronously: logged as an error; other handlers of the same event and the later
  events still run; the cursor moves on. A synchronous throw is turned into a rejection before it can reach the queue,
  which it would otherwise end, stopping the listener for good.
- No handler for a pattern: logged (`Handler not found for: <route>`).

## Tests

- `eth.decode.spec.ts` (no chain, prepared logs, no controllers so the route shows in `Handler not found for`):
  a log goes only to the entry with its event when two entries share the address; an event both entries have goes to
  both; an entry with the event but another address does not decode it; the address matches in any letter case; an
  event no entry on the address registered is neither decoded nor reported; a real decode error is logged with `debug`
  and silent without it.
- `eth.handler.spec.ts` (no chain, prepared logs): a handler that throws synchronously on one event is logged, the next
  event is delivered, and the listener keeps delivering on the next call.
- `eth.registry.spec.ts` (no chain, the client filters prepared logs by the requested addresses, handlers register
  contracts): a contract registered by a handler gets its logs of the same range, once; a chain of registrations
  (a factory deploys a factory that deploys a token) takes one pass per level; an address registered before the range
  is fetched once, and the next pass asks only for the new address; a handler that calls `getPastEvents` for the new
  contract does not block the listener (its logs come twice).
- `eth.block.spec.ts` (no chain, a stub client): no block handler and no registry keep the cursor; the block event
  carries the head and `processedBlockNumber`, and the cursor stays while no contract is registered; contracts are
  scanned without a block handler.
- `eth.cursor.spec.ts` (local chain, the real client wrapped to fail once): a log of a block reached while the
  registry was empty is delivered once the contract is added; after a failed `eth_getLogs` the cursor stays and the next
  cycle delivers the log; a rejected handler is logged, the log is not delivered again and the cursor moves on; the
  processed block seen by a handler and by the block event is before the block being handled, and after the cycle
  the block is processed; a failed head read gives no block event and keeps the cursor.
- `utils/get-past-events.spec.ts` (local chain): 1, 200, 399, 400 and 401 blocks with `chunkSize` 200 are requested
  once each, at most 200 per request; without `chunkSize`, one request.
- `eth.service.spec.ts`: against a local chain (`JSON_RPC_ADDR` in `.env`, `docker compose up`).
