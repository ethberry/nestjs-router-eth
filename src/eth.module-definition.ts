import { ConfigurableModuleBuilder } from "@nestjs/common";

import { IEthModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<IEthModuleOptions>().build();
