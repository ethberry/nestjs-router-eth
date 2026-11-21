import type { HttpTransport } from "viem";
import { http } from "viem";

// The HTTP transport for every client that sends transactions (and the package's own public client).
//
// Why: Cosmos EVM. Before signing, a transaction needs its nonce, gas limit and fees. When the caller leaves any of them
// out (sendTransaction, writeContract, deployContract), viem first asks the node eth_fillTransaction for all of them at
// once. What viem does with the answer:
// - the node fills the transaction: viem uses it;
// - the node does not know the method (Besu: "Method not found"): viem fills the fields itself with
//   eth_getTransactionCount, eth_estimateGas and the fee methods;
// - the node answers with a revert: viem throws, it does not try the plain methods.
//
// Cosmos EVM (cosmos/evm, its reference node evmd; checked on v0.7.4, chain id 262144) has the method, but runs it on a
// state that is not the chain's current one: an account funded after genesis has no balance there, a contract deployed
// after genesis has no code. So eth_fillTransaction reverts ("ERC20: transfer amount exceeds balance" for a token
// transfer of a funded account, "FacetHasNoCode" for a deploy that calls a diamond), while eth_estimateGas for the same
// request on the same node succeeds. Every write viem prepared itself failed there before it was signed; reads and
// events were not affected.
//
// Fix: the method is excluded (viem's `methods.exclude`). viem gets MethodNotSupportedRpcError without asking the node
// and fills the transaction with the plain methods, as it always did on Besu. This holds on every chain, with no chain
// check: on Besu nothing changes, on a node with a working eth_fillTransaction (geth) it costs a few calls instead of
// one. A client built on viem's plain http() still asks the method and still fails on Cosmos EVM.
//
// Test against a local evmd: providers/transport.integration.spec.ts (npm run test:integration). Details and the
// rejected alternatives: docs/transport.md, docs/adr/0001-transport-excludes-eth-fill-transaction.md.
export const viemTransport = (url?: string): HttpTransport =>
  http(url, { methods: { exclude: ["eth_fillTransaction"] } });
