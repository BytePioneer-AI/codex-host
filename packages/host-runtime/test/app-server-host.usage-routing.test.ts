import { setImmediate } from "node:timers/promises";

import type { HostUsage } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObservedSessionUsage } from "../src/observed-session-usage.js";
import {
  createFixture,
  JsonLineCollector,
  method,
  requestId,
  requiredMessageId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const usageMethod = "codexhost/thread/usage/inspect";
const steeringMethod = "codexhost/thread/steering/inspect";

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

afterEach(() => vi.restoreAllMocks());

describe("Usage inspection request routing", () => {
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
      const fixture = createFixture({
        accountControl: accountControl(stage === "credits" ? "a" : null),
      });
      const native = new JsonLineCollector(fixture.official.stdin);
      fixture.official.stdin.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line) as JsonObject;
          if (message.method === "turn/steer" || message.method === "thread/read") {
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
        expect(
          await fixture.collector.waitFor((message) => requestId(message, 10)),
        ).not.toHaveProperty("error");
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
});
