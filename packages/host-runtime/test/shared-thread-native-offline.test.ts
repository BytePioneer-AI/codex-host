import { expect, it } from "vitest";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { createRemoteSharedExternalBridge } from "../src/run-host-runtime.js";
import {
  createFixture,
  stopFixture,
  writeRequest,
  JsonLineCollector,
  startPiThread,
} from "./app-server-host-fixture.js";
import type { JsonObject } from "@codexhost/protocol-core";

it.each(["offline", "missing-runtime"])(
  "keeps proven native and legacy SSH requests local when the shared owner is %s",
  async (mode) => {
    const bridge =
      mode === "missing-runtime"
        ? createRemoteSharedExternalBridge(undefined, {}, "unused")
        : new SharedThreadBridge({
            connect: async () => {
              throw Error("shared owner offline");
            },
            delegateCreates: false,
            diagnose: () => {},
          });
    bridge.options.delegateCreates = false;
    const fixture = createFixture({ sharedThreads: bridge });
    const nativeRequests: JsonObject[] = [];
    const incoming = new JsonLineCollector(fixture.official.stdin);
    fixture.official.stdin.on("data", () => {
      for (const r of incoming.messages.splice(0)) {
        nativeRequests.push(r);
        const params = r.params as JsonObject;
        const reply =
          r.method === "thread/list"
            ? {
                result: {
                  data: [
                    {
                      id: "native",
                      modelProvider: "openai",
                      cwd: "/native",
                      createdAt: 1,
                      updatedAt: 1,
                      status: { type: "idle" },
                    },
                  ],
                  nextCursor: null,
                },
              }
            : params?.threadId === "native"
              ? {
                  result: {
                    thread: { id: "native", modelProvider: "openai", turns: [] },
                    turn: { id: "turn", status: "completed", items: [], error: null },
                  },
                }
              : { error: { code: -32600, message: "not a native Thread" } };
        fixture.official.stdout.write(JSON.stringify({ id: r.id, ...reply }) + "\n");
      }
    });
    try {
      const legacy = await startPiThread(fixture);
      bridge.options.delegateCreates = true;
      writeRequest(fixture.desktopInput, {
        id: 41,
        method: "thread/read",
        params: { threadId: legacy, includeTurns: true },
      });
      expect(await fixture.collector.waitFor((m) => m.id === 41)).toMatchObject({
        result: { thread: { id: legacy, modelProvider: "codexhost" } },
      });
      writeRequest(fixture.desktopInput, {
        id: 42,
        method: "thread/read",
        params: { threadId: "native", includeTurns: false },
      });
      expect(await fixture.collector.waitFor((m) => m.id === 42)).toMatchObject({
        result: { thread: { id: "native" } },
      });
      writeRequest(fixture.desktopInput, {
        id: 43,
        method: "turn/start",
        params: { threadId: "native", input: [{ type: "text", text: "hello" }] },
      });
      expect(await fixture.collector.waitFor((m) => m.id === 43)).not.toHaveProperty("error");
      writeRequest(fixture.desktopInput, {
        id: 44,
        method: "turn/start",
        params: { threadId: "shared-only", input: [{ type: "text", text: "never send" }] },
      });
      expect(await fixture.collector.waitFor((m) => m.id === 44)).toHaveProperty("error");
      expect(
        nativeRequests
          .filter((r) => r.method === "turn/start")
          .map((r) => (r.params as JsonObject).threadId),
      ).toEqual(["native"]);
      writeRequest(fixture.desktopInput, { id: 45, method: "thread/list", params: {} });
      expect(await fixture.collector.waitFor((m) => m.id === 45)).toMatchObject({
        result: { data: expect.arrayContaining([expect.objectContaining({ id: "native" })]) },
      });
      writeRequest(fixture.desktopInput, {
        id: 46,
        method: "thread/start",
        params: { cwd: "/external", model: "codexhost/pi-native" },
      });
      expect(await fixture.collector.waitFor((m) => m.id === 46)).toHaveProperty("error");
      expect(nativeRequests.filter((r) => r.method === "thread/start")).toEqual([]);
    } finally {
      await stopFixture(fixture);
    }
  },
);
