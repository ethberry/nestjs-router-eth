# Event routing

`ViemService` reads contract logs from the chain on a cron and routes each decoded event to the controller methods
whose `@EventPattern({ contractType, eventName })` matches.

## Registry

- An app registers what to listen to with `updateRegistry(contract)`, where `contract` has `contractType`,
  `contractAddress[]`, `contractInterface` and `eventSignatures[]`. Entries are keyed by `contractType`: a second call
  for the same type adds its addresses and signatures to the existing entry.
- One address may sit in several entries (a token entry, its `ACCESS_CONTROL` or `OWNABLE` entry, a diamond's facets).
- `eventSignatures` are human-readable signatures without the `event` keyword
  (`Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`).

## A cycle (`listen`)

1. Nothing happens until the registry or a block handler exists.
2. The head block is read and emitted to block handlers (`BLOCK_EVENT`).
3. `toBlock` = head − `latency` (option); nothing more while `fromBlock` (option) is above it.
4. `getPastEvents(registry, fromBlock, toBlock, chunkSize)` processes the range in passes. A pass is one `eth_getLogs`
   per chunk of `chunkSize` blocks (0 = one request) for the addresses and signatures of the pass.
5. Each log is decoded with each entry that has the log's address **and** whose `eventSignatures` contain the log's
   selector (`topics[0]`, `toEventSelector` of each signature, computed once per pass). So a log of one entry is never
   decoded with another entry's ABI that shares the address. Matches go to the handlers with the pattern
   `{ contractType: entry.contractType, eventName }` through one queue, one event at a time (block events too). The
   pass ends when the queue is empty: the handlers of its events, and of every event queued meanwhile, have finished.
6. A handler may call `updateRegistry` during a pass (a factory's `Deployed` event registers the new contract). After
   each pass the registry is compared with what this range has fetched, by entry type, address and signature; the
   next pass fetches the range again for what is new only, and passes repeat until nothing new appears. So every log
   of a registered contract is delivered once, also the logs a new contract emits in the range that registered it
   (constructor events, the first mint, a call right after the deploy). The first pass covers the whole registry.
7. `fromBlock` becomes `toBlock + 1`. A cycle that is still running when the cron fires again is skipped.

## `getPastEvents` from a handler

A handler may call `getPastEvents` itself (a handler runs inside an `AsyncLocalStorage` context that marks it). Such a
call fetches and decodes its range once, queues the events behind the running handler and returns without waiting for
them: waiting would block the queue it is part of. There are no extra passes for contracts registered by those
events; the listen cycle's own pass picks them up. Its events are delivered in addition to the listen cycle's, so a
handler that re-reads a range a new contract is already fetched for gets those logs twice. Since the cycle delivers
the logs of a contract registered during the range, a handler does not need to re-read them.

## Cursor and failures

- The cursor is `fromBlock` in memory. After a cycle it becomes `toBlock + 1` whatever happened in the cycle: the handlers' results do not hold it back.
- The block event fires at the start of a cycle with the **head**, before the logs of the range are read; it is not a "range done" signal. `getLastProcessedBlock()` returns `toBlock` (head − `latency`) after a cycle.
- An app saves the cursor itself (core-eth: `getLastBlock()`, the head, in `onModuleDestroy`). A save of the head skips the last `latency` blocks on restart; a crash before the save re-reads from the last saved block.
- Delivery is at most once per range: an event whose handler rejected, or whose chunk failed to load, is not delivered again.
- A handler that throws synchronously is handled like a rejection (below): logged, the listener goes on.
- `@ethberry/nestjs-solana` and `@ethberry/nestjs-ton` behave differently: they read a whole range first, keep the cursor until every handler succeeded, and retry the range (at least once).

## Errors

- `eth_getLogs` failing: logged as an error, the chunk gives no logs (and the cursor moves past them).
- A decode that fails although the selector matched (a wrong ABI for the registered signature): with the `debug`
  option, the log and the error are logged; without it, skipped silently.
- A handler that rejects, or throws synchronously: logged as an error; other handlers of the same event and the later events still run; the cursor moves on. A synchronous throw is turned into a rejection before it can reach the queue, which it would otherwise end, stopping the listener for good.
- No handler for a pattern: logged (`Handler not found for: <route>`).

## Tests

- `viem.decode.spec.ts` (no chain, prepared logs, no controllers so the route shows in `Handler not found for`):
  a log goes only to the entry with its event when two entries share the address; an event both entries have goes to
  both; an entry with the event but another address does not decode it; the address matches in any letter case; an
  event no entry on the address registered is neither decoded nor reported; a real decode error is logged with `debug`
  and silent without it.
- `viem.handler.spec.ts` (no chain, prepared logs): a handler that throws synchronously on one event is logged, the next
  event is delivered, and the listener keeps delivering on the next call.
- `viem.registry.spec.ts` (no chain, the client filters prepared logs by the requested addresses, handlers register
  contracts): a contract registered by a handler gets its logs of the same range, once; a chain of registrations
  (a factory deploys a factory that deploys a token) takes one pass per level; an address registered before the range
  is fetched once, and the next pass asks only for the new address; a handler that calls `getPastEvents` for the new
  contract does not block the listener (its logs come twice).
- `viem.service.spec.ts`, `viem.block.spec.ts`: against a local chain (`JSON_RPC_ADDR` in `.env`, `docker compose up`).
