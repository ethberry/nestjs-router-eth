# 0001. The transport never asks eth_fillTransaction

Status: accepted
Date: 2026-11-21

## Context

The apps send transactions with viem through a wallet client: core-eth on every chain it serves, among them a Cosmos
EVM chain (`cosmos/evm`, the reference chain `evmd`, checked on v0.7.4 with EVM chain id 262144).

**How viem prepares a transaction.** Before signing, a transaction needs its nonce, its gas limit and its fees. When
the caller leaves any of them out, viem (`prepareTransactionRequest`, 2.57) first sends the whole request to the node
as `eth_fillTransaction` and takes the filled fields from the answer. What happens next depends on the answer:

- the node fills the transaction: viem uses the result;
- the node does not know the method (`Method not found`, `MethodNotSupportedRpcError`): viem remembers that for the
  client and fills the fields itself with `eth_getTransactionCount`, `eth_estimateGas` and the fee methods
  (`eth_maxPriorityFeePerGas`, the base fee of the latest block, or `eth_gasPrice`);
- the node answers with a revert: viem treats the transaction as failing and throws. It does not try the other way.

**Besu** (our local and test chains) has no `eth_fillTransaction`, so viem always takes the second way there.

**Cosmos EVM** (`evmd`) has the method, but executes it on a state that is not the chain's current one: an account
funded after genesis has no balance there, and a contract deployed after genesis has no code. `eth_estimateGas`,
`eth_call` and `eth_gasPrice` on the same node answer from the current state. On the local node:

- a fresh account, funded by the genesis account `dev0`, sends an ERC-20 `transfer` of the native coin
  (`0xEeee…EeE`): `eth_fillTransaction` reverts with `ERC20: transfer amount exceeds balance`, while the account holds
  the coin and `eth_estimateGas` for the same request succeeds;
- a deploy whose constructor calls a contract deployed earlier reverts with that contract's "no code" error
  (`FacetHasNoCode` of a diamond; found by Framework and Contracts).

A transaction from the genesis account to a genesis contract happens to pass, which hides the problem on a first try.

**What it broke.** Every write that viem prepared itself on a Cosmos EVM chain failed before it was signed: core-eth's
transactions there (the e2e stand got around it with its own fill for that chain only). Reads and event listening do not
use the method and were not affected. Browser wallets (MetaMask and the like) fill transactions themselves, so the UIs
were not affected either.

## Decision

`viemTransport(url?)` is viem's `http` transport with `eth_fillTransaction` in `methods.exclude`. viem gets
`MethodNotSupportedRpcError` without a request to the node and fills nonce, gas and fees with the plain methods, the way
it does on Besu. It is the transport of the package's public client (`VIEM_CLIENT`) and is exported, so an app builds
its wallet client on it.

It applies to every chain, not only to Cosmos EVM: there is no chain check.

## Alternatives

- **A chain-level `prepareTransactionRequest` hook** (viem's `beforeFillTransaction`) that fills nonce, gas and fees
  through raw RPC calls. It works (the e2e stand of framework does it for its Cosmos chain), but it re-implements
  viem's own fill: fee type (EIP-1559 or legacy), multipliers, the request fields `eth_estimateGas` takes. It must also
  avoid viem actions inside the hook, as they come back to it. Excluding the method keeps viem's own, tested path.
- **A Cosmos special case** (the exclusion or the hook only for the Cosmos chain ids): the chain list would live in code
  and every new Cosmos EVM chain would need a change. The plain path works on every chain, so no case is needed.
- **Setting nonce, gas and fees in every call of the apps**: many call sites, and each one missed fails on Cosmos only.
- **Waiting for a fixed `evmd`**: nothing to wait on in our code, and running nodes keep their version.

## Consequences

- On every chain a transaction prepared by viem costs a few plain RPC calls instead of one `eth_fillTransaction`. Besu
  did that already. A node whose `eth_fillTransaction` works well (geth) loses nothing but that one round trip.
- An app gets the fix only for clients built on `viemTransport()`. A client built on viem's plain `http()` still asks
  `eth_fillTransaction` and fails on Cosmos EVM.
- Revisit this ADR when `evmd` answers `eth_fillTransaction` from the current state, or if a chain we serve needs that
  method (a fee-payer relay, as on Tempo, fills a transaction only through it).
- The integration test `src/providers/transport.integration.spec.ts` (`npm run test:integration`, a local `evmd`)
  checks the decision against the real node.
