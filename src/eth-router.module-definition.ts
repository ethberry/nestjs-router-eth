import { ConfigurableModuleBuilder } from "@nestjs/common";

import { IEthRouterModuleOptions } from "./interfaces";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<IEthRouterModuleOptions>().build();
