import { ConfigService } from "@nestjs/config";
import { privateKeyToAccount } from "viem/accounts";
import { Hash } from "viem";

import { ETH_ACCOUNT } from "../eth.constants";

export const ethAccountProvider = {
  provide: ETH_ACCOUNT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const privateKey = configService.get<Hash>("PRIVATE_KEY", "0x");
    return privateKeyToAccount(privateKey);
  },
};
