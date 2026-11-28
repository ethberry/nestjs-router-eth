// Sent after a range is done: every log of it was read and every handler of its events has finished
export interface IBlockEvent {
  // the head of the chain the range was read up to (the range ends `latency` blocks below it)
  blockNumber: bigint;
  // the last block of the range (getLastProcessedBlock): save it as the cursor and resume from the next block
  processedBlockNumber: bigint;
}
