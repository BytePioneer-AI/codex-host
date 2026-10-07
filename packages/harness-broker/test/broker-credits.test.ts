import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type AccountCreditsSnapshot } from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(withCredits = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-credits-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptorPath = path.join(root, "broker.json");
  const credits = vi.fn<() => AccountCreditsSnapshot | null>(() => null);
  const inspectAccount = vi.fn(async () => null);
  const native = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("claude-code")), {
    inspectAccount,
    ...(withCredits ? { credits } : {}),
  });
  const server = await startHarnessBrokerServer({
    descriptorPath,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cx-credits-${randomUUID()}`
        : path.join(root, "b.sock"),
    adapter: native,
  });
  cleanups.push(() => server.close());
  const client = new BrokeredHarnessAdapter({ descriptorPath });
  cleanups.push(() => client.close());
  return { client, native, credits, inspectAccount };
}

const snapshot: AccountCreditsSnapshot = {
  usedPercent: 25,
  periodType: "five_hour",
  resetsAt: "2026-09-01T05:00:00Z",
  productUsage: [{ product: "7-day window", usagePercent: 60, resetsAt: "2026-09-07T00:00:00Z" }],
};

it("forwards native 5-hour and 7-day credits into the synchronous Host-facing cache", async () => {
  const { client, native, credits, inspectAccount } = await fixture();
  expect(client.credits()).toBeNull();
  credits.mockReturnValue(snapshot);
  await expect(client.refreshCredits()).resolves.toEqual(snapshot);
  expect(client.credits()).toEqual(snapshot);

  // Real zero usage is not missing data; missing data must not retain old windows.
  credits.mockReturnValue({ usedPercent: 0, periodType: "seven_day" });
  await client.refreshCredits();
  expect(client.credits()).toEqual({ usedPercent: 0, periodType: "seven_day" });
  credits.mockReturnValue(null);
  await client.refreshCredits();
  expect(client.credits()).toBeNull();
  expect(inspectAccount).not.toHaveBeenCalled();
  expect(native.sessions).toHaveLength(0);
});

it("returns no credits when the native adapter has no credits capability", async () => {
  const { client } = await fixture(false);
  await expect(client.refreshCredits()).resolves.toBeNull();
  expect(client.credits()).toBeNull();
});

it("coalesces concurrent refreshes and makes no requests after close", async () => {
  const { client, credits } = await fixture();
  credits.mockReturnValue(snapshot);
  const first = client.refreshCredits();
  const second = client.refreshCredits();
  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(credits).toHaveBeenCalledOnce();
  await client.close();
  expect(client.credits()).toBeNull();
  await expect(client.refreshCredits()).resolves.toBeNull();
  expect(credits).toHaveBeenCalledOnce();
});

it("keeps the last valid snapshot on failed or invalid reads and can refresh again", async () => {
  const { client, credits } = await fixture();
  credits.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  await expect(client.refreshCredits()).resolves.toBeNull();
  credits.mockReturnValue(snapshot);
  await client.refreshCredits();
  credits.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  await expect(client.refreshCredits()).resolves.toEqual(snapshot);
  credits.mockReturnValueOnce({ usedPercent: 101, periodType: "five_hour" });
  await expect(client.refreshCredits()).resolves.toEqual(snapshot);
  credits.mockReturnValue({ usedPercent: 42, periodType: "seven_day" });
  await expect(client.refreshCredits()).resolves.toEqual({
    usedPercent: 42,
    periodType: "seven_day",
  });
});
