import type { PublicClient } from "viem";
import { Chain, createPublicClient } from "viem";

import { ETH_CLIENT } from "../eth-router.constants.js";
import { CHAIN_PROVIDER } from "./chain.js";
import { ethTransport } from "./transport.js";

export const ethClientProvider = {
  provide: ETH_CLIENT,
  inject: [CHAIN_PROVIDER],
  useFactory: (chain: Chain): PublicClient => {
    return createPublicClient({
      chain: chain,
      transport: ethTransport(),
    });
  },
};
