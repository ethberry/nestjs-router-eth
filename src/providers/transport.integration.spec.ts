import { createPublicClient, createWalletClient, defineChain, parseAbi } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ethTransport } from "./transport.js";

// Needs a running Cosmos EVM node (cosmos/evm `evmd`, `local_node.sh`) and env:
// - COSMOS_EVM_RPC_URL: its Ethereum JSON-RPC (default http://127.0.0.1:8645);
// - COSMOS_EVM_DEV_KEY: the key of a funded genesis account (dev0 of local_node.sh).
// evmd answers eth_fillTransaction from a state where accounts funded after genesis have no balance, so a write viem
// prepares through it reverts. Run: npm run test:integration.

const rpcUrl = process.env.COSMOS_EVM_RPC_URL ?? "http://127.0.0.1:8645";
const devKey = process.env.COSMOS_EVM_DEV_KEY as Hex;
// the native denom as an ERC-20 (x/erc20 of local_node.sh)
const nativeErc20 = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("ethTransport on Cosmos EVM", function () {
  it("sends a transaction from an account funded after genesis", async function () {
    const chain = defineChain({
      id: 262144,
      name: "Cosmos EVM",
      nativeCurrency: { name: "Test", symbol: "ATEST", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: ethTransport() });
    const dev = createWalletClient({ account: privateKeyToAccount(devKey), chain, transport: ethTransport() });
    const fresh = createWalletClient({
      account: privateKeyToAccount(generatePrivateKey()),
      chain,
      transport: ethTransport(),
    });

    const funding = await dev.sendTransaction({ to: fresh.account.address, value: 10n ** 18n });
    await publicClient.waitForTransactionReceipt({ hash: funding });

    const hash = await fresh.writeContract({
      address: nativeErc20,
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [dev.account.address, 1n],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    expect(receipt.status).toEqual("success");
  });
});
