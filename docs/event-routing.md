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
4. `getPastEvents(registry, fromBlock, toBlock, chunkSize)`: one `eth_getLogs` per chunk of `chunkSize` blocks (0 = one
   request) for all addresses and all signatures of the registry.
5. Each log is decoded with each entry that has the log's address **and** whose `eventSignatures` contain the log's
   selector (`topics[0]`, `toEventSelector` of each signature, computed once per call). So a log of one entry is never
   decoded with another entry's ABI that shares the address. Matches go to the handlers with the pattern
   `{ contractType: entry.contractType, eventName }`.
6. `fromBlock` becomes `toBlock + 1`. A cycle that is still running when the cron fires again is skipped.

## Errors

- `eth_getLogs` failing: logged as an error, the chunk gives no logs.
- A decode that fails although the selector matched (a wrong ABI for the registered signature): with the `debug`
  option, the log and the error are logged; without it, skipped silently.
- A handler that rejects: logged as an error; other handlers of the same event still run.
- No handler for a pattern: logged (`Handler not found for: <route>`).

## Tests

- `viem.decode.spec.ts` (no chain, prepared logs, no controllers so the route shows in `Handler not found for`):
  a log goes only to the entry with its event when two entries share the address; an event both entries have goes to
  both; an entry with the event but another address does not decode it; the address matches in any letter case; an
  event no entry on the address registered is neither decoded nor reported; a real decode error is logged with `debug`
  and silent without it.
- `viem.service.spec.ts`, `viem.block.spec.ts`: against a local chain (`JSON_RPC_ADDR` in `.env`, `docker compose up`).
