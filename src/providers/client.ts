import type { PublicClient } from "viem";
import { Chain, createPublicClient, http } from "viem";

import { ETH_CLIENT } from "../eth-router.constants";
import { CHAIN_PROVIDER } from "./chain";

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
