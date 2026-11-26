import { jest } from "@jest/globals";
import { config } from "dotenv";
import { createPublicClient, http } from "viem";

import { getPastEvents } from "./get-past-events.js";

// Chunked reading against the local chain (`JSON_RPC_ADDR`): consecutive, non-overlapping inclusive ranges of at most
// `chunkSize` blocks, the last one ending at `toBlock`.

config();

const publicClient = createPublicClient({ transport: http(process.env.JSON_RPC_ADDR) });

describe("getPastEvents", function () {
  it.each([
    [1n, [[0n, 0n]]],
    [200n, [[0n, 199n]]],
    [
      399n,
      [
        [0n, 199n],
        [200n, 398n],
      ],
    ],
    [
      400n,
      [
        [0n, 199n],
        [200n, 399n],
      ],
    ],
    [
      401n,
      [
        [0n, 199n],
        [200n, 399n],
        [400n, 400n],
      ],
    ],
  ])("requests each of %s blocks once, at most 200 per request", async function (blocks, expected) {
    const head = await publicClient.getBlockNumber();
    const from = head - 1000n;
    const getLogs = jest.spyOn(publicClient, "getLogs");

    try {
      await getPastEvents(publicClient, [], ["Transfer(address,address,uint256)"], from, from + blocks - 1n, 200);
      const requested = getLogs.mock.calls.map(([args]) => [
        (args!.fromBlock! as bigint) - from,
        (args!.toBlock! as bigint) - from,
      ]);
      expect(requested).toEqual(expected);
    } finally {
      getLogs.mockRestore();
    }
  });

  it("requests the whole range at once without chunkSize", async function () {
    const head = await publicClient.getBlockNumber();
    const from = head - 1000n;
    const getLogs = jest.spyOn(publicClient, "getLogs");

    try {
      await getPastEvents(publicClient, [], ["Transfer(address,address,uint256)"], from, from + 399n);
      const requested = getLogs.mock.calls.map(([args]) => [args!.fromBlock, args!.toBlock]);
      expect(requested).toEqual([[from, from + 399n]]);
    } finally {
      getLogs.mockRestore();
    }
  });
});
