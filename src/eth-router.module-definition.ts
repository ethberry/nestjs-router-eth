import { ConfigurableModuleBuilder } from "@nestjs/common";

import { IEthRouterModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<IEthRouterModuleOptions>().build();
