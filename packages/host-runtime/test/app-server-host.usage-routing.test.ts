import { setImmediate } from "node:timers/promises";

import type { HostUsage } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { encodeExternalTransportSelection } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  IDLE_RELEASE_SETTINGS_METHOD,
  LOADED_SESSIONS_METHOD,
  type AccountCreditsSnapshot,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObservedSessionUsage } from "../src/observed-session-usage.js";
import {
  closeFixture,
  createFixture,
  JsonLineCollector,
  method,
  requestId,
  requiredMessageId,
  rollbackCapableAdapter,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const inspectMethod = "codexhost/thread/inspect";
const usageMethod = "codexhost/thread/usage/inspect";
const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
const steeringMethod = "codexhost/thread/steering/inspect";
const MINUTE = 60_000;

function accountControl(accountId: string | null) {
  return {
    currentAccountId: () => accountId,
    snapshot: () => ({
      version: 2 as const,
      currentAccountId: accountId,
      phase: "ready" as const,
      revision: 1,
      accounts: accountId ? [{ accountId, label: "Synthetic Account" }] : [],
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Usage inspection request routing", () => {
  it("loads session credits on demand after an explicit Account refresh without a native notification", async () => {
    let currentAccountId: string | null = null;
    const snapshot = () => accountControl(currentAccountId).snapshot();
    const refresh = vi.fn(async () => {
      currentAccountId = "a";
      return snapshot();
    });
    const fixture = createFixture({
      accountControl: { currentAccountId: () => currentAccountId, snapshot, refresh },
    });
    const native = new JsonLineCollector(fixture.official.stdin);
    fixture.official.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        if (message.method === "initialize" || message.method === "account/rateLimits/read") {
          writeRequest(fixture.official.stdout, {
            id: requiredMessageId(message),
            result:
              message.method === "initialize"
                ? { userAgent: "synthetic-codex" }
                : { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } },
          });
        }
      }
    });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "synthetic-desktop", version: "1" } },
      });
      await fixture.collector.waitFor((message) => requestId(message, 1));
      await setImmediate();
      expect(refresh).not.toHaveBeenCalled();
      expect(currentAccountId).toBeNull();

      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/account/refresh",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: { currentAccountId: "a", accounts: [{ accountId: "a" }] },
      });
      writeRequest(fixture.desktopInput, { id: 3, method: usageMethod, params: { threadId } });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { accountCredits: { usedPercent: 12, periodType: "five_hour" } },
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(
        native.messages.filter((message) => method(message, "account/rateLimits/read")),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["credits", "history"] as const)(
    "lets steering inspection, native steer and read finish while %s is pending",
    async (stage) => {
      const entered = Promise.withResolvers<undefined>();
      const history = Promise.withResolvers<HostUsage | null>();
      if (stage === "history") {
        vi.spyOn(ObservedSessionUsage.prototype, "read").mockImplementation(() => {
          entered.resolve(undefined);
          return history.promise;
        });
      }
      const control = accountControl(stage === "credits" ? "a" : null);
      const refreshAccount = vi.fn(async () => control.snapshot());
      const fixture = createFixture({
        accountControl: { ...control, refresh: refreshAccount },
      });
      const native = new JsonLineCollector(fixture.official.stdin);
      fixture.official.stdin.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line) as JsonObject;
          if (message.method === "initialize") {
            writeRequest(fixture.official.stdout, {
              id: requiredMessageId(message),
              result: { userAgent: "synthetic-codex" },
            });
          } else if (message.method === "turn/steer" || message.method === "thread/read") {
            writeRequest(fixture.official.stdout, {
              id: requiredMessageId(message),
              result: { nativeMethod: message.method },
            });
          }
        }
      });
      let quotaRequest: JsonObject | undefined;
      let released = false;
      const release = () => {
        released = true;
        history.resolve({ totalTokens: 42 });
        if (quotaRequest) {
          writeRequest(fixture.official.stdout, {
            id: requiredMessageId(quotaRequest),
            result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } },
          });
          quotaRequest = undefined;
        }
      };
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, {
          id: 9,
          method: "initialize",
          params: { clientInfo: { name: "synthetic-desktop", version: "1" } },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 9))).toEqual({
          id: 9,
          result: { userAgent: "synthetic-codex" },
        });
        await setImmediate();
        expect(refreshAccount).not.toHaveBeenCalled();
        writeRequest(fixture.desktopInput, { id: 10, method: usageMethod, params: { threadId } });
        if (stage === "credits") {
          quotaRequest = await native.waitFor((message) =>
            method(message, "account/rateLimits/read"),
          );
        } else await entered.promise;
        expect(fixture.collector.messages.some((message) => requestId(message, 10))).toBe(false);

        writeRequest(fixture.desktopInput, {
          id: 11,
          method: steeringMethod,
          params: { threadId },
        });
        const steerParams = {
          threadId,
          expectedTurnId: "active-turn",
          input: [{ type: "text", text: "next detail" }],
        };
        writeRequest(fixture.desktopInput, { id: 12, method: "turn/steer", params: steerParams });
        writeRequest(fixture.desktopInput, {
          id: 13,
          method: "thread/read",
          params: { threadId, includeTurns: true },
        });
        const replies = await Promise.all(
          [11, 12, 13].map((id) => fixture.collector.waitFor((message) => requestId(message, id))),
        );
        expect(replies).toEqual([
          { id: 11, result: { delivery: "official" } },
          { id: 12, result: { nativeMethod: "turn/steer" } },
          { id: 13, result: { nativeMethod: "thread/read" } },
        ]);
        expect(native.messages.find((message) => method(message, "turn/steer"))?.params).toEqual(
          steerParams,
        );
        expect(released).toBe(false);
        expect(fixture.collector.messages.some((message) => requestId(message, 10))).toBe(false);
        release();
        const usageReply = await fixture.collector.waitFor((message) => requestId(message, 10));
        expect(usageReply).not.toHaveProperty("error");
        if (stage === "credits") {
          expect(usageReply).toMatchObject({
            result: { accountCredits: { usedPercent: 12, periodType: "five_hour" } },
          });
        }
        expect(refreshAccount).not.toHaveBeenCalled();
      } finally {
        release();
        await stopFixture(fixture);
      }
    },
  );

  it.each([false, true])(
    "drains pending Usage before shutdown and replies once (failure=%s)",
    async (failure) => {
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<HostUsage | null>();
      const read = vi.spyOn(ObservedSessionUsage.prototype, "read").mockImplementation(() => {
        entered.resolve(undefined);
        return release.promise;
      });
      const close = vi.spyOn(ObservedSessionUsage.prototype, "close");
      const fixture = createFixture({ accountControl: accountControl(null) });
      let exited = false;
      void fixture.running.then(() => {
        exited = true;
      });
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, { id: 20, method: usageMethod, params: { threadId } });
        await entered.promise;
        writeRequest(fixture.desktopInput, {
          id: 21,
          method: steeringMethod,
          params: { threadId },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 21))).toMatchObject({
          result: { delivery: "official" },
        });
        fixture.desktopInput.end();
        await setImmediate();
        expect(exited).toBe(false);
        expect(close).not.toHaveBeenCalled();
        expect(fixture.official.stdin.writableEnded).toBe(false);
        if (failure) release.reject(new Error("Synthetic usage failure"));
        else release.resolve({ totalTokens: 42 });
        const reply = await fixture.collector.waitFor((message) => requestId(message, 20));
        expect(reply).toMatchObject(
          failure ? { error: { code: -32603 } } : { result: { usage: { totalTokens: 42 } } },
        );
        expect(await fixture.running).toBe(0);
        expect(read).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(fixture.collector.messages.filter((message) => requestId(message, 20))).toHaveLength(
          1,
        );
      } finally {
        release.resolve(null);
        await stopFixture(fixture);
      }
    },
  );

  it("keeps same-Thread mutations ordered while Usage can inspect the live Session", async () => {
    const fixture = createFixture();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const original = fixture.mappingStore.setArchived.bind(fixture.mappingStore);
    const writes: boolean[] = [];
    vi.spyOn(fixture.mappingStore, "setArchived").mockImplementation(async (id, archived) => {
      writes.push(archived);
      if (archived) {
        entered.resolve(undefined);
        await release.promise;
      }
      return original(id, archived);
    });
    try {
      const externalId = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 30,
        method: "thread/archive",
        params: { threadId: externalId },
      });
      await entered.promise;
      writeRequest(fixture.desktopInput, {
        id: 31,
        method: "thread/unarchive",
        params: { threadId: externalId },
      });
      writeRequest(fixture.desktopInput, {
        id: 32,
        method: usageMethod,
        params: { threadId: externalId },
      });
      expect(
        await fixture.collector.waitFor((message) => requestId(message, 32)),
      ).not.toHaveProperty("error");
      expect(writes).toEqual([true]);
      expect(fixture.collector.messages.some((message) => requestId(message, 31))).toBe(false);
      release.resolve(undefined);
      await Promise.all(
        [30, 31].map((id) => fixture.collector.waitFor((message) => requestId(message, id))),
      );
      expect(writes).toEqual([true, false]);
    } finally {
      release.resolve(undefined);
      await stopFixture(fixture);
    }
  });

  it("keeps passive inspect non-extending while hot, protected in-flight, and non-waking when cold", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(100_000);
    const credits: AccountCreditsSnapshot = { usedPercent: 25, periodType: "five_hour" };
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const creditsAdapter = Object.assign(adapter, { credits: () => credits });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", creditsAdapter]]),
    });
    const readCreditsGate = Promise.withResolvers<AccountCreditsSnapshot | null>();
    try {
      const selectedModel = adapter.catalog.defaultModel;
      const transportModelId = encodeExternalTransportSelection("pi", { model: selectedModel });
      const externalId = await startPiThread(fixture, transportModelId);
      const turn = await startPiTurn(fixture, externalId, 100);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turn));
      const session = adapter.sessions[0];
      if (!session) throw new Error("Missing fake Pi session");
      vi.setSystemTime(100_040);
      session.appendText("hello");
      await fixture.collector.waitFor((message) => method(message, "item/agentMessage/delta"));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turn));

      writeRequest(fixture.desktopInput, {
        id: 101,
        method: IDLE_RELEASE_SETTINGS_METHOD,
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 101));

      const close = vi.spyOn(session, "close");
      const open = vi.spyOn(adapter, "open");

      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      writeRequest(fixture.desktopInput, {
        id: 102,
        method: inspectMethod,
        params: { threadId: externalId },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 102))).toMatchObject({
        result: {
          owner: "external",
          harnessId: "pi",
          transportModelId,
          effectiveModel: selectedModel,
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
          locked: true,
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 103,
        method: usageMethod,
        params: { threadId: externalId },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 103))).toMatchObject({
        result: {
          threadId: externalId,
          accountCreditsSupported: true,
          accountCredits: credits,
          usage: { timeToFirstOutputMs: 40 },
        },
      });
      expect(
        await fixture.host.handleClientRequest(inspectMethod, { threadId: externalId }),
      ).toMatchObject({ result: { owner: "external", harnessId: "pi" } });

      // Hold a hot usage inspect across the 10-minute mark to prove occupancy protection.
      const enteredCredits = Promise.withResolvers<undefined>();
      Object.assign(session, {
        readAccountCredits: () => {
          enteredCredits.resolve(undefined);
          return readCreditsGate.promise;
        },
      });
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      writeRequest(fixture.desktopInput, {
        id: 104,
        method: usageMethod,
        params: { threadId: externalId },
      });
      await enteredCredits.promise;
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(close).not.toHaveBeenCalled();

      readCreditsGate.resolve(credits);
      expect(await fixture.collector.waitFor((message) => requestId(message, 104))).toMatchObject({
        result: { threadId: externalId, accountCredits: credits },
      });

      // Because none of the passive inspections extended lastActivity, the next tick releases.
      await vi.advanceTimersByTimeAsync(MINUTE);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      writeRequest(fixture.desktopInput, { id: 105, method: LOADED_SESSIONS_METHOD, params: {} });
      expect(await fixture.collector.waitFor((message) => requestId(message, 105))).toEqual({
        id: 105,
        result: [],
      });

      // Cold inspections read persisted metadata and cached harness capabilities without waking.
      writeRequest(fixture.desktopInput, {
        id: 106,
        method: inspectMethod,
        params: { threadId: externalId },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 106))).toMatchObject({
        result: {
          owner: "external",
          harnessId: "pi",
          transportModelId,
          effectiveModel: selectedModel,
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
          usage: { timeToFirstOutputMs: 40 },
          locked: true,
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 107,
        method: usageMethod,
        params: { threadId: externalId },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 107))).toMatchObject({
        result: {
          threadId: externalId,
          accountCreditsSupported: true,
          accountCredits: credits,
          usage: { timeToFirstOutputMs: 40 },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 108,
        method: usageMethod,
        params: { threadId: externalId, refresh: "exact" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 108))).toMatchObject({
        result: {
          threadId: externalId,
          accountCreditsSupported: true,
          accountCredits: credits,
          usage: { timeToFirstOutputMs: 40 },
        },
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      readCreditsGate.resolve(null);
      await stopFixture(fixture);
    }
  });

  it.each(["resolve", "reject"] as const)(
    "protects background refreshUsage() from idle release without extending lastActivity (%s)",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(100_000);
      const fixture = createFixture();
      const refreshGate = Promise.withResolvers<undefined>();
      try {
        const externalId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing fake Pi session");
        const entered = Promise.withResolvers<undefined>();
        vi.spyOn(session, "refreshUsage").mockImplementation(() => {
          entered.resolve(undefined);
          return refreshGate.promise;
        });
        const close = vi.spyOn(session, "close");

        writeRequest(fixture.desktopInput, {
          id: 201,
          method: IDLE_RELEASE_SETTINGS_METHOD,
          params: { enabled: true, timeoutMinutes: 10 },
        });
        await fixture.collector.waitFor((message) => requestId(message, 201));

        await vi.advanceTimersByTimeAsync(9 * MINUTE);
        writeRequest(fixture.desktopInput, {
          id: 202,
          method: usageMethod,
          params: { threadId: externalId, refresh: "exact" },
        });
        expect(
          await fixture.collector.waitFor((message) => requestId(message, 202)),
        ).not.toHaveProperty("error");
        await entered.promise;

        // While refreshUsage() is still running past the 10-minute idle threshold, do not close.
        await vi.advanceTimersByTimeAsync(5 * MINUTE);
        expect(close).not.toHaveBeenCalled();
        writeRequest(fixture.desktopInput, { id: 203, method: LOADED_SESSIONS_METHOD, params: {} });
        expect(await fixture.collector.waitFor((message) => requestId(message, 203))).toMatchObject(
          {
            result: [{ threadId: externalId, state: "busy", reason: "operation" }],
          },
        );

        if (outcome === "reject") refreshGate.reject(new Error("Synthetic refreshUsage failure"));
        else refreshGate.resolve(undefined);
        await setImmediate();
        writeRequest(fixture.desktopInput, { id: 204, method: LOADED_SESSIONS_METHOD, params: {} });
        expect(await fixture.collector.waitFor((message) => requestId(message, 204))).toMatchObject(
          {
            result: [{ threadId: externalId, state: "idle", reason: "none" }],
          },
        );
        await vi.advanceTimersByTimeAsync(MINUTE);
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
        if (outcome === "reject") {
          expect(fixture.diagnosticOutput.read()?.toString()).toContain(
            "Synthetic refreshUsage failure",
          );
        }
      } finally {
        refreshGate.resolve(undefined);
        await stopFixture(fixture);
      }
    },
  );

  it("resolves real history capabilities for cold Threads on first inspect without waking adapter.open()", async () => {
    const seed = createFixture();
    let externalId: string;
    try {
      externalId = await startPiThread(seed);
    } finally {
      await closeFixture(seed);
    }

    const adapter = rollbackCapableAdapter();
    const open = vi.spyOn(adapter, "open");
    const inspect = vi.spyOn(adapter, "inspect");
    const fresh = createFixture({
      mappingStoreDirectory: seed.mappingStoreDirectory,
      externalAdapters: new Map([["pi", adapter]]),
    });
    try {
      await fresh.ready;
      writeRequest(fresh.desktopInput, {
        id: 301,
        method: inspectMethod,
        params: { threadId: externalId },
      });
      expect(await fresh.collector.waitFor((message) => requestId(message, 301))).toMatchObject({
        result: {
          owner: "external",
          harnessId: "pi",
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
          locked: true,
        },
      });
      expect(open).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledTimes(1);

      // Subsequent cold inspections reuse cached history capabilities without re-probing.
      writeRequest(fresh.desktopInput, {
        id: 302,
        method: inspectMethod,
        params: { threadId: externalId },
      });
      expect(await fresh.collector.waitFor((message) => requestId(message, 302))).toMatchObject({
        result: {
          owner: "external",
          harnessId: "pi",
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
          locked: true,
        },
      });
      expect(open).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      await stopFixture(fresh);
    }
  });

  it("does not extend lastActivity when refreshUsage() emits session.usage.changed while idle, while Turn events still refresh it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(100_000);
    const fixture = createFixture();
    try {
      const externalId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake Pi session");
      vi.spyOn(session, "refreshUsage").mockImplementation(async () => {
        session.publishUsage({ totalTokens: 123, inputTokens: 100, outputTokens: 23 });
      });
      const close = vi.spyOn(session, "close");

      writeRequest(fixture.desktopInput, {
        id: 401,
        method: IDLE_RELEASE_SETTINGS_METHOD,
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 401));

      // Normal Turn events refresh lastActivity and postpone idle release past the initial 10m mark.
      await vi.advanceTimersByTimeAsync(9 * MINUTE);
      const turn = await startPiTurn(fixture, externalId, 402);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turn));
      session.appendText("hello");
      await fixture.collector.waitFor((message) => method(message, "item/agentMessage/delta"));
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turn));

      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(close).not.toHaveBeenCalled();

      // Passive session.usage.changed emitted by exact refresh while idle must not refresh lastActivity.
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      const priorUsageUpdates = fixture.collector.messages.filter((message) =>
        method(message, THREAD_USAGE_UPDATED_METHOD),
      ).length;
      const usageUpdated = fixture.collector.waitFor(
        (message) =>
          method(message, THREAD_USAGE_UPDATED_METHOD) &&
          fixture.collector.messages.filter((item) => method(item, THREAD_USAGE_UPDATED_METHOD))
            .length > priorUsageUpdates,
      );
      writeRequest(fixture.desktopInput, {
        id: 403,
        method: usageMethod,
        params: { threadId: externalId, refresh: "exact" },
      });
      expect(
        await fixture.collector.waitFor((message) => requestId(message, 403)),
      ).not.toHaveProperty("error");
      await usageUpdated;

      writeRequest(fixture.desktopInput, { id: 404, method: LOADED_SESSIONS_METHOD, params: {} });
      expect(await fixture.collector.waitFor((message) => requestId(message, 404))).toMatchObject({
        result: [
          { threadId: externalId, state: "idle", reason: "timeout", inactiveMs: 9 * MINUTE },
        ],
      });

      await vi.advanceTimersByTimeAsync(MINUTE);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    } finally {
      await stopFixture(fixture);
    }
  });
});
