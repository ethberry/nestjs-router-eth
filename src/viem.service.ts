import { AsyncLocalStorage } from "node:async_hooks";

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoggerService } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { MessageHandler } from "@nestjs/microservices";
import { transformPatternToRoute } from "@nestjs/microservices/utils/index.js";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { EMPTY, from, Observable, Subject } from "rxjs";
import { finalize, mergeAll, mergeMap } from "rxjs/operators";
import { decodeEventLog, Hash, toEventSelector } from "viem";
import type { PublicClient } from "viem";

import { getPastEvents } from "./utils/get-past-events";
import { BLOCK_EVENT, VIEM_CLIENT } from "./viem.constants";
import { MODULE_OPTIONS_TOKEN } from "./viem.module-definition";
import type { IBlockEvent, IContractOptions, IDiscoveredHandler, ILogEvent, IViemModuleOptions } from "./interfaces";

const blockPattern = { eventName: BLOCK_EVENT };

// an event on its way to the handlers
interface IRoutedEvent {
  pattern: Record<string, string>;
  description: ILogEvent;
  log: unknown;
}

@Injectable()
export class ViemService {
  private instanceId: string;
  private cronLock = false;
  private registry: IContractOptions[] = [];
  private subject = new Subject<IRoutedEvent>();
  // events emitted whose handlers have not finished, and who waits for that number to reach 0
  private pending = 0;
  private drainWaiters: Array<() => void> = [];
  // set while a handler runs: getPastEvents called from a handler must not wait for the queue the handler blocks
  private handlerContext = new AsyncLocalStorage<boolean>();

  constructor(
    @Inject(Logger)
    protected readonly loggerService: LoggerService,
    @Inject(VIEM_CLIENT)
    protected readonly client: PublicClient,
    protected readonly discoveryService: DiscoveryService,
    protected readonly metadataScanner: MetadataScanner,
    protected readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN)
    protected options: IViemModuleOptions,
    protected schedulerRegistry: SchedulerRegistry,
  ) {
    this.subject
      .pipe(
        mergeMap(
          ({ pattern, description, log }) =>
            from(this.call(pattern, description, log)).pipe(
              mergeAll(),
              finalize(() => this.settle()),
            ),
          1,
        ),
      )
      .subscribe({
        next: v => {
          loggerService.log(v, `${ViemService.name}-${this.instanceId}`);
        },
        error: e => {
          loggerService.error(e);
        },
        complete: () => {
          loggerService.log("complete", `${ViemService.name}-${this.instanceId}`);
        },
      });
  }

  public init(): void {
    // generate instance id
    this.instanceId = (Math.random() + 1).toString(36).substring(7);
    // setup cron job
    return this.setCronJob();
  }

  public setCronJob(): void {
    const job = new CronJob(this.options.cron, async () => {
      // if previous cron task still running - skip
      if (this.cronLock) {
        return;
      }
      this.cronLock = true;
      try {
        await this.listen();
      } finally {
        this.cronLock = false;
      }
    });

    this.schedulerRegistry.addCronJob(`ethListener_${this.instanceId}`, job);
    job.start();
  }

  public async listen(): Promise<void> {
    const handlers = await this.blockHandlers();
    // wait while the system is configured
    if (!this.registry.length && !handlers.length) {
      return;
    }

    // an RPC error on the head skips the tick: no block event, the cursor stays
    const head = await this.getLastBlock().catch((e: unknown) => {
      this.logError(e);
      return null;
    });
    if (head === null) {
      return;
    }

    await this.emitBlock(head);

    const toBlock = head - this.options.latency;
    // no contracts yet (the app registers them later), or waiting for confirmation: the cursor stays
    if (!this.registry.length || this.options.fromBlock > toBlock) {
      return;
    }

    this.loggerService.log(
      `getPastEvents No: ${this.options.fromBlock} - ${toBlock}`,
      `${ViemService.name}-${this.instanceId}`,
    );
    // a failed eth_getLogs ends the tick: the cursor stays and the next tick reads the range again; a rejected handler
    // is logged and does not hold the range back (each event is delivered once)
    try {
      await this.getPastEvents(this.registry, this.options.fromBlock, toBlock, this.options.chunkSize);
    } catch (e) {
      this.logError(e);
      return;
    }
    this.options.fromBlock = toBlock + 1n;
  }

  public async getPastEvents(
    registry: IContractOptions[],
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize?: number,
  ): Promise<void> {
    // called from a handler: the handlers run one at a time, so the events of this call queue behind the running
    // handler; waiting for them here would block that handler and the listener for good. One pass, no waiting.
    if (this.handlerContext.getStore()) {
      await this.routeLogs(registry, fromBlock, toBlock, chunkSize);
      return;
    }

    // a handler can add to the registry while the range is processed (a factory's Deployed event adds the new
    // contract): after a pass and all queued handlers, the range is fetched again for what appeared during it, until
    // nothing new appears
    const fetched = new Set<string>();
    let pass = this.notFetched(registry, fetched);
    while (pass.length) {
      await this.routeLogs(pass, fromBlock, toBlock, chunkSize);
      await this.drained();
      pass = this.notFetched(registry, fetched);
    }
  }

  public updateRegistry(contract: IContractOptions): void {
    const entry = this.registry.find(e => e.contractType === contract.contractType);

    if (entry) {
      entry.contractAddress = [...new Set([...entry.contractAddress, ...contract.contractAddress])];
      entry.eventSignatures = [...new Set([...entry.eventSignatures, ...contract.eventSignatures])];
    } else {
      this.registry.push(contract);
    }

    this.loggerService.log(
      `ETH Listener updated: ${contract.contractAddress.join(", ")}`,
      `${ViemService.name}-${this.instanceId}`,
    );
  }

  public getRegistry(): IContractOptions[] {
    return this.registry;
  }

  // rejects on an RPC error
  public getLastBlock(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  protected getHandlerByPattern<T extends Array<Record<string, string>>>(
    route: string,
  ): Promise<Array<IDiscoveredHandler<T>>> {
    const methods: Array<IDiscoveredHandler<T>> = [];
    for (const wrapper of this.discoveryService.getControllers()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== "function") {
          continue;
        }
        const meta = this.reflector.get<T | undefined>(PATTERN_METADATA, handler);
        if (meta) {
          methods.push({ meta, methodName, handler: handler as IDiscoveredHandler<T>["handler"], instance });
        }
      }
    }
    return Promise.resolve(
      methods.filter(method => {
        return method.meta.some(meta => transformPatternToRoute(meta) === route);
      }),
    );
  }

  protected async call(
    pattern: Record<string, string>,
    description: ILogEvent,
    context?: any,
  ): Promise<Observable<any>> {
    const route = transformPatternToRoute(pattern);
    const discoveredMethodsWithMeta = await this.getHandlerByPattern(route);

    if (!discoveredMethodsWithMeta.length) {
      this.loggerService.log(`Handler not found for: ${route}`, `${ViemService.name}-${this.instanceId}`);
      return Promise.resolve(EMPTY);
    }

    return Promise.allSettled(
      discoveredMethodsWithMeta.map(discoveredMethodWithMeta => {
        // a handler that throws synchronously becomes a rejection like any other: thrown out of here, it would end the
        // queue's subscription and stop the listener for good
        return this.handlerContext.run(true, () =>
          Promise.resolve().then(() =>
            (discoveredMethodWithMeta.handler.bind(discoveredMethodWithMeta.instance) as MessageHandler)(
              description,
              context,
            ),
          ),
        );
      }),
    ).then(res => {
      res.forEach(r => {
        if (r.status === "rejected") {
          this.loggerService.error(r.reason, `${ViemService.name}-${this.instanceId}`);
        }
      });
      return from(["OK"]);
    });
  }

  // the last block whose logs and handlers have all completed; before the first such range, the block before the start
  // (0n when the start is block 0)
  public getLastProcessedBlock(): bigint {
    return this.options.fromBlock > 0n ? this.options.fromBlock - 1n : 0n;
  }

  public destroy(): void {
    this.subject.complete();
  }

  private async emitBlock(blockNumber: bigint): Promise<void> {
    const handlers = await this.blockHandlers();
    if (!handlers.length) {
      return;
    }

    const args: IBlockEvent = { blockNumber, processedBlockNumber: this.getLastProcessedBlock() };
    this.emit({
      pattern: blockPattern,
      description: {
        name: BLOCK_EVENT,
        args,
      },
      log: args,
    });
    // the block handlers finish before the logs are read; their rejections do not hold the range back
    await this.drained();
  }

  private blockHandlers() {
    return this.getHandlerByPattern(transformPatternToRoute(blockPattern));
  }

  // the part of the registry whose logs this range has not fetched yet: per entry, each address with the signatures
  // not fetched for it; addresses with the same such signatures share one entry
  private notFetched(registry: IContractOptions[], fetched: Set<string>): IContractOptions[] {
    const pass: IContractOptions[] = [];
    for (const entry of registry) {
      const groups = new Map<string, IContractOptions>();
      for (const address of entry.contractAddress) {
        const key = (signature: string) => `${entry.contractType} ${address.toLowerCase()} ${signature}`;
        const eventSignatures = entry.eventSignatures.filter(signature => !fetched.has(key(signature)));
        if (!eventSignatures.length) {
          continue;
        }
        eventSignatures.forEach(signature => fetched.add(key(signature)));
        const group = groups.get(eventSignatures.join("\n"));
        if (group) {
          group.contractAddress.push(address);
        } else {
          groups.set(eventSignatures.join("\n"), { ...entry, contractAddress: [address], eventSignatures });
        }
      }
      pass.push(...groups.values());
    }
    return pass;
  }

  // fetches the logs of the range for the registry and queues them for the handlers
  private async routeLogs(
    registry: IContractOptions[],
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize?: number,
  ): Promise<void> {
    const allAddress = registry.reduce<Hash[]>((memo, current) => memo.concat(current.contractAddress as Hash[]), []);
    const allSignatures = registry.reduce<string[]>((memo, current) => memo.concat(current.eventSignatures), []);

    // an RPC error rejects: the range must not look empty
    const logs = await getPastEvents(this.client, allAddress, allSignatures, fromBlock, toBlock, chunkSize);

    // one address can sit in several entries (a token and its access-control or ownable entry): an entry decodes only
    // the logs of its own events, so a decode error left after this is a real one
    const selectors = registry.map(
      entry => new Set(entry.eventSignatures.map(signature => toEventSelector(signature))),
    );

    for (const log of logs) {
      for (const [index, entry] of registry.entries()) {
        if (!entry.contractAddress.map(a => a.toLowerCase()).includes(log.address.toLowerCase())) {
          continue;
        }
        if (!selectors[index].has(log.topics[0]!)) {
          continue;
        }

        try {
          // throws DecodeLogDataMismatch
          const logDescription = decodeEventLog({
            abi: entry.contractInterface,
            data: log.data,
            topics: log.topics,
          });

          this.loggerService.log(JSON.stringify(logDescription, null, "\t"), `${ViemService.name}-${this.instanceId}`);

          const description = {
            // the selector matched one of the entry's events, so the decoded log has its name
            name: logDescription.eventName!,
            args: logDescription.args,
          };

          this.emit({
            pattern: {
              contractType: entry.contractType,
              eventName: description.name,
            },
            description,
            log,
          });
        } catch (e: unknown) {
          if (this.options.debug) {
            this.loggerService.log("CAN'T PARSE LOG", `${ViemService.name}-${this.instanceId}`);
            this.loggerService.log(JSON.stringify(log, null, "\t"), `${ViemService.name}-${this.instanceId}`);
            this.loggerService.error(e); // DecodeLogDataMismatch
          }
        }
      }
    }
  }

  private logError(e: unknown): void {
    this.loggerService.error(e, `${ViemService.name}-${this.instanceId}`);
  }

  private emit(event: IRoutedEvent): void {
    this.pending++;
    this.subject.next(event);
  }

  // an emitted event's handlers have finished
  private settle(): void {
    this.pending--;
    if (!this.pending) {
      this.drainWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  // resolves when the handlers of every emitted event have finished, also of events emitted meanwhile
  private drained(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.drainWaiters.push(resolve));
  }
}
