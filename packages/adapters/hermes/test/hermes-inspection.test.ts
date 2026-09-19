import { afterEach, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";
import * as inventory from "../src/hermes-inventory.js";

afterEach(() => vi.restoreAllMocks());
const first = {
  models: [{ modelId: "test:first", label: "first", provider: "Test" }],
  currentModelId: "test:first",
};
function adapter() {
  vi.spyOn(HermesGatewayTransport, "probe").mockResolvedValue("/unused/python");
  return new HermesAdapter({ command: process.execPath });
}

it("keeps the last native catalog on timeout and replaces it after recovery", async () => {
  const read = vi
    .spyOn(inventory, "readHermesModelInventory")
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new inventory.HermesInventoryTimeoutError())
    .mockResolvedValueOnce({
      models: [{ modelId: "test:second", label: "second", provider: "Test" }],
      currentModelId: "test:second",
    });
  const a = adapter();
  try {
    const initial = await a.inspect();
    expect(initial.status).toBe("ready");
    expect(await a.inspect({ refresh: true })).toEqual(initial);
    expect(await a.inspect({ refresh: true })).toMatchObject({
      status: "ready",
      catalog: { models: [{ label: "Test / second" }] },
    });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    await a.close();
  }
});

it("does not hide a first-load timeout or a non-timeout failure", async () => {
  vi.spyOn(inventory, "readHermesModelInventory")
    .mockRejectedValueOnce(new inventory.HermesInventoryTimeoutError())
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new inventory.HermesInventoryError("malformed output"));
  const a = adapter();
  try {
    expect(await a.inspect()).toMatchObject({
      status: "error",
      error: { message: "Hermes model inventory probe timed out" },
    });
    expect((await a.inspect({ refresh: true })).status).toBe("ready");
    expect(await a.inspect({ refresh: true })).toMatchObject({
      status: "error",
      error: { message: "malformed output" },
    });
  } finally {
    await a.close();
  }
});

it("coalesces concurrent inventory reads, including refresh requests", async () => {
  let resolve!: (value: inventory.HermesInventory) => void;
  const read = vi.spyOn(inventory, "readHermesModelInventory").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const a = adapter();
  try {
    const pending = [a.inspect(), a.inspect({ refresh: true }), a.inspect()];
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const calls = read.mock.calls.length;
    resolve(first);
    expect((await Promise.all(pending)).every((r) => r.status === "ready")).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await a.close();
  }
});
