import type { HttpTransport } from "viem";
import { http } from "viem";

// viem asks eth_fillTransaction first whenever a transaction lacks its nonce, gas or fees. A node that answers it from a
// wrong state (Cosmos EVM's evmd) makes the write revert, and viem does not fall back. With the method excluded, viem
// fills them through eth_getTransactionCount, eth_estimateGas and the fee methods, as it does on a node without
// eth_fillTransaction (Besu). See docs/transport.md.
export const viemTransport = (url?: string): HttpTransport =>
  http(url, { methods: { exclude: ["eth_fillTransaction"] } });
