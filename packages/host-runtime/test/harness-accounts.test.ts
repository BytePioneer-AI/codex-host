import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type HarnessAccountSnapshot } from "@codexhost/shared-contracts";
import {
  inspectHarnessAccount,
  inspectHarnessAccounts,
  listHarnessAccountSources,
} from "../src/harness-accounts.js";

const snapshot: HarnessAccountSnapshot = {
  email: "person@example.com",
  plan: "max",
  credits: { usedPercent: 25, periodType: "five_hour" },
};
const adapter = (id: string) => new FakeHarnessAdapter(harnessIdSchema.parse(id));

describe("read-only Harness accounts", () => {
  it("lists only progressive account sources with their plugin display names", () => {
    const ready = Object.assign(adapter("sample-agent"), {
      inspectAccount: vi.fn(async () => snapshot),
    });
    expect(
      listHarnessAccountSources(
        [ready, adapter("legacy-agent")],
        [{ id: ready.harnessId, name: "Sample Agent", version: "1.0.0" }],
      ),
    ).toEqual({
      sources: [{ harnessId: "sample-agent", harnessName: "Sample Agent" }],
    });
  });

  it("inspects one account without exposing plugin failures or malformed snapshots", async () => {
    const ready = Object.assign(adapter("sample-agent"), {
      inspectAccount: vi.fn(async () => snapshot),
    });
    const malformed = Object.assign(adapter("bad-agent"), {
      inspectAccount: async () => ({ ...snapshot, token: "must not escape" }),
    });
    await expect(
      inspectHarnessAccount(ready, [
        { id: ready.harnessId, name: "Sample Agent", version: "1.0.0" },
      ]),
    ).resolves.toEqual({
      harnessId: "sample-agent",
      harnessName: "Sample Agent",
      account: snapshot,
    });
    await expect(inspectHarnessAccount(malformed, [])).resolves.toEqual({
      harnessId: "bad-agent",
      harnessName: "bad-agent",
      account: null,
    });
  });

  it("returns only real quota, isolates failure, and uses plugin display metadata without opening Threads", async () => {
    const ready = Object.assign(adapter("sample-agent"), {
      inspectAccount: vi.fn(async () => snapshot),
    });
    const open = vi.spyOn(ready, "open");
    const api = Object.assign(adapter("api-agent"), { inspectAccount: vi.fn(async () => null) });
    const failed = Object.assign(adapter("broken-agent"), {
      inspectAccount: vi.fn(async () => {
        throw new Error("secret diagnostic");
      }),
    });
    expect(
      await inspectHarnessAccounts(
        [ready, api, failed, adapter("legacy-agent")],
        [{ id: ready.harnessId, name: "Sample Agent", version: "1.0.0" }],
      ),
    ).toEqual({
      accounts: [{ ...snapshot, harnessId: "sample-agent", harnessName: "Sample Agent" }],
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("does not reuse the previous account when native authentication stops returning quota", async () => {
    const inspectAccount = vi
      .fn<() => Promise<HarnessAccountSnapshot | null>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(null);
    const native = Object.assign(adapter("sample-agent"), { inspectAccount });
    expect((await inspectHarnessAccounts([native], [])).accounts).toHaveLength(1);
    expect(await inspectHarnessAccounts([native], [])).toEqual({ accounts: [] });
  });

  it("bounds unresponsive plugins and rejects malformed or secret-bearing snapshots", async () => {
    const hung = Object.assign(adapter("hung-agent"), {
      inspectAccount: () => new Promise<null>(() => undefined),
    });
    const malformed = Object.assign(adapter("bad-agent"), {
      inspectAccount: async () => ({ ...snapshot, token: "must not escape" }),
    });
    expect(await inspectHarnessAccounts([hung, malformed], [], 5)).toEqual({ accounts: [] });
  });
});
