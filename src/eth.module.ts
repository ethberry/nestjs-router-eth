import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { chainProvider, ethClientProvider } from "./providers";
import { EthService } from "./eth.service";
import { ConfigurableModuleClass } from "./eth.module-definition";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [chainProvider, ethClientProvider, Logger, EthService],
  exports: [EthService],
})
export class EthModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly ethService: EthService) {
    super();
  }

  public onModuleInit(): void {
    return this.ethService.init();
  }

  public onModuleDestroy(): void {
    return this.ethService.destroy();
  }
}
