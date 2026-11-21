import { jest } from "@jest/globals";
import { MethodNotSupportedRpcError } from "viem";

import { viemTransport } from "./transport.js";

// The node is never asked eth_fillTransaction; other methods reach it.
describe("viemTransport", function () {
  const fetchFn = jest.spyOn(globalThis, "fetch");

  afterEach(function () {
    fetchFn.mockReset();
  });

  afterAll(function () {
    fetchFn.mockRestore();
  });

  it("refuses eth_fillTransaction without a request to the node", async function () {
    const { request } = viemTransport("http://127.0.0.1:1")({});

    await expect(request({ method: "eth_fillTransaction", params: [{}] })).rejects.toBeInstanceOf(
      MethodNotSupportedRpcError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends other methods to the node", async function () {
    fetchFn.mockResolvedValue(Response.json({ jsonrpc: "2.0", id: 0, result: "0x1" }));
    const { request } = viemTransport("http://127.0.0.1:1")({});

    await expect(request({ method: "eth_blockNumber" })).resolves.toEqual("0x1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
