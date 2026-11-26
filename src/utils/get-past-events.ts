import { Hash, parseAbiItem, PublicClient } from "viem";

export const getPastEvents = async (
  client: PublicClient,
  address: Hash[],
  allSignatures: string[],
  fromBlockNumber: bigint,
  toBlockNumber: bigint,
  chunkSize = 0,
) => {
  // consecutive inclusive ranges of at most chunkSize blocks (0: one range), none when fromBlock > toBlock
  const step = chunkSize > 0 ? BigInt(chunkSize) : toBlockNumber - fromBlockNumber + 1n;
  const chunks = [];
  for (let start = fromBlockNumber; start <= toBlockNumber; start += step) {
    const end = start + step - 1n;
    chunks.push({ fromBlock: start, toBlock: end < toBlockNumber ? end : toBlockNumber });
  }

  const topics = allSignatures.map(signature => parseAbiItem(`event ${signature}`));

  const events = [];
  for (const chunk of chunks) {
    const logs = await client.getLogs({
      address,
      events: topics,
      fromBlock: chunk.fromBlock,
      toBlock: chunk.toBlock,
    });

    if (logs?.length) {
      events.push(...logs);
    }
  }

  return events;
};
