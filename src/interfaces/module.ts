import { CronExpression } from "@nestjs/schedule";

export interface IEthModuleOptions {
  fromBlock: bigint;
  latency: bigint;
  debug: boolean;
  cron: CronExpression;
  chunkSize?: number;
}
