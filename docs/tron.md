# Tron

The router reads Tron with no Tron code: a java-tron node serves an Ethereum JSON-RPC on the path `/jsonrpc`, and the
router's viem client reads it like any EVM chain (`eth_blockNumber`, `eth_getLogs`, the ABI decoding).

## Configuration

- `RPC_URL`: the node's JSON-RPC, `<node>/jsonrpc`.
- `CHAIN_ID`: what `eth_chainId` of that node answers. Test chains have ids above 2^31 (the local TRE's is new on every
  start); the chain provider reads the id with `Number`, which holds them.
- `latency`: the blocks a Tron network needs to solidify a block (19 on mainnet); 0 on a local node that makes a block
  only on a transaction, or the head is never reached.
- `chunkSize`: at most 5000, the node's `eth_getLogs` range limit.
- Addresses: the JSON-RPC shows contracts and accounts as 20-byte hex without the `41` prefix; register them so. The
  Base58 `T…` form and the `41…` hex belong to the app's boundary.
- Native TRX has 6 decimals; the chain provider's `nativeCurrency` does not matter for reading.

## Writes

The JSON-RPC has no `eth_sendRawTransaction`: a deploy, a transfer or a contract call is a native transaction. The node
builds it (`/wallet/deploycontract`, `/wallet/triggersmartcontract`), the sender signs its `txID` with its secp256k1 key
and sends it with `/wallet/broadcasttransaction`; `/wallet/gettransactioninfobyid` answers once a block holds it. A
secp256k1 key has the same 20-byte address on Tron as on Ethereum.

## Local node

- The `tron` service of `docker-compose.yml` (container `nestjs-router-eth-tron`, port 9190 → the node's 9090), image
  `tronbox/tre`: the native API, `/jsonrpc` and the TRE admin API (`/admin/accounts-json`: the funded accounts of this
  start) on one port.
- It makes a block only when a transaction comes.
- Every start is a new chain with new accounts. A container starts only once (the image appends to its config on every
  start): a stopped node is recreated (`docker compose up -d --force-recreate tron`), so it has no restart policy.

## Tests

`eth-router.tron.spec.ts`: deploys the ERC20 of the EVM tests on the local node through the native API, mints, and
expects the router to deliver that `Transfer` (from the zero address, to the minter, the value) read over `/jsonrpc`,
with the mint's block processed.
