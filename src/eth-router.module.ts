import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { chainProvider, ethClientProvider } from "./providers";
import { EthRouterService } from "./eth-router.service";
import { ConfigurableModuleClass } from "./eth-router.module-definition";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [chainProvider, ethClientProvider, Logger, EthRouterService],
  exports: [EthRouterService],
})
export class EthRouterModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly ethRouterService: EthRouterService) {
    super();
  }

  public onModuleInit(): void {
    return this.ethRouterService.init();
  }

  public onModuleDestroy(): void {
    return this.ethRouterService.destroy();
  }
}
