# Transport

`viemTransport(url?)` is the HTTP transport of the package's clients (`viemHttpClientProvider`, `VIEM_CLIENT`). It is
exported so an app builds its own clients, a wallet client included, on the same transport. Without `url` it uses the
chain's default RPC URL (`RPC_URL` in `chainProvider`).

## No `eth_fillTransaction`

viem (`prepareTransactionRequest`) asks the node `eth_fillTransaction` first whenever a transaction lacks its nonce,
gas or fees (`sendTransaction`, `writeContract`, `deployContract`). If the node reverts there, viem throws; only an
unsupported method makes it fall back to the plain calls.

- Besu has no `eth_fillTransaction` (`Method not found`): viem fills through `eth_getTransactionCount`,
  `eth_estimateGas` and the fee methods.
- Cosmos EVM (`evmd`) has it, but answers from a state where an account funded after genesis has no balance and a
  contract deployed after genesis has no code. A write from such an account, or one that touches such a contract,
  reverts there (`transfer amount exceeds balance`, `FacetHasNoCode`), though `eth_estimateGas` on the same request
  succeeds.

`viemTransport` excludes the method (viem's `methods.exclude`): viem gets `MethodNotSupportedRpcError` without a
request to the node and fills the transaction as on Besu, on every chain. A caller that sets nonce, gas and fees itself
is not affected. Why, for which chain, and the alternatives: [ADR 0001](adr/0001-transport-excludes-eth-fill-transaction.md).

## Tests

- `src/providers/transport.spec.ts`: the method is refused without a request to the node; other methods reach it.
- `src/providers/transport.integration.spec.ts` (`npm run test:integration`, not in `npm test`): a fresh account,
  funded by a genesis account, sends an ERC-20 transfer on a local `evmd`. Env: `COSMOS_EVM_RPC_URL` (default
  `http://127.0.0.1:8645`), `COSMOS_EVM_DEV_KEY` (a funded genesis account of `local_node.sh`).
