import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  open: io.open,
}));

import { openMutationGuard } from "../src/operation-guard.js";

const native = it.skipIf(process.platform !== "win32" && process.platform !== "darwin");
afterEach(() => vi.resetAllMocks());

native("fails closed if exclusive-open flags are ignored", async () => {
  const first = { close: vi.fn(async () => {}) };
  const contender = { close: vi.fn(async () => {}) };
  io.open.mockResolvedValueOnce(first).mockResolvedValueOnce(contender);
  await expect(openMutationGuard("fixture.lock")).rejects.toThrow(
    "Exclusive update metadata handles are unavailable",
  );
  expect(first.close).toHaveBeenCalledOnce();
  expect(contender.close).toHaveBeenCalledOnce();
});

native("holds the first handle when a second open is correctly excluded", async () => {
  const first = { close: vi.fn(async () => {}) };
  io.open
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EBUSY" }));
  const guard = await openMutationGuard("fixture.lock");
  expect(guard).toBe(first);
  expect(first.close).not.toHaveBeenCalled();
  await guard.close();
  expect(first.close).toHaveBeenCalledOnce();
});

native("closes its handle on an unexpected probe error", async () => {
  const first = { close: vi.fn(async () => {}) };
  io.open
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(Object.assign(new Error("fixture IO error"), { code: "EIO" }));
  await expect(openMutationGuard("fixture.lock")).rejects.toThrow("fixture IO error");
  expect(first.close).toHaveBeenCalledOnce();
});
