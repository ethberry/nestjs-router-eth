import type { PublicClient } from "viem";
import { Chain, createPublicClient, http } from "viem";

import { ETH_CLIENT } from "../eth.constants.js";
import { CHAIN_PROVIDER } from "./chain.js";

export const ethClientProvider = {
  provide: ETH_CLIENT,
  inject: [CHAIN_PROVIDER],
  useFactory: (chain: Chain): PublicClient => {
    return createPublicClient({
      chain: chain,
      transport: http(),
    });
  },
};
