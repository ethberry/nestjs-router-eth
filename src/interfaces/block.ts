export interface IBlockEvent {
  // the head of the chain at the start of the tick
  blockNumber: bigint;
  // the last block whose logs and handlers have all completed (getLastProcessedBlock): a safe cursor to resume from
  processedBlockNumber: bigint;
}
