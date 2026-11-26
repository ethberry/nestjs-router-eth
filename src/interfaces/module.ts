import { CronExpression } from "@nestjs/schedule";

export interface IEthRouterModuleOptions {
  fromBlock: bigint;
  latency: bigint;
  debug: boolean;
  cron: CronExpression;
  chunkSize?: number;
}
