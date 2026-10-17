import assert from "node:assert/strict";
import { test } from "vitest";
import {
  IsolatedSessions,
  type SessionHarnesses,
  type SessionDataStore,
  type HarnessSessionLike,
} from "../src/index.js";

test("unconfirmed idle close cannot resume or reuse the previous native writer", async () => {
  const files = new Map<string, unknown>();
  const data: SessionDataStore = {
    path: (...parts) => parts.join("/"),
    readJson: <T>(key: string, fallback: T) => (files.get(key) ?? fallback) as T,
    writeJson: (key, value) => {
      files.set(key, structuredClone(value));
    },
    readLines: <T>(key: string) => (files.get(key) ?? []) as T[],
    writeLines: (key, value) => {
      files.set(key, [...value]);
    },
    appendLine: (key, value) => {
      files.set(key, [...((files.get(key) ?? []) as unknown[]), value]);
    },
  };
  const output: unknown[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  let opens = 0;
  let starts = 0;
  let closes = 0;
  const session: HarnessSessionLike = {
    harnessId: "codex",
    capabilities: {},
    initialState: {
      nativeRef: {
        harnessId: "codex",
        nativeSessionId: "native",
        locator: { codexHome: "/isolated" },
      },
    },
    initialUsage: null,
    outputs: {
      async *[Symbol.asyncIterator]() {
        while (!stopped) {
          if (!output.length)
            await new Promise<void>((r) => {
              wake = r;
            });
          while (output.length) yield output.shift() as never;
        }
      },
    },
    readSnapshot: async () => ({ ok: true, value: { turns: [] } }),
    execute: async (command) => {
      if (command.type === "turn.start") {
        starts++;
        output.push({
          kind: "event",
          event: {
            type: "turn.completed",
            turnId: command.turnId,
            outcome: { status: "completed" },
          },
        });
        wake?.();
      }
      return { ok: true, value: {} };
    },
    close: async () => {
      closes++;
      throw new Error("exit not confirmed");
    },
  };
  const harnesses: SessionHarnesses = {
    ids: () => ["codex"],
    manifest: () => ({ name: "Codex" }),
    preferredSelection: undefined,
    inspect: async () => ({ status: "unavailable", error: { message: "test" } }),
    modelCatalog: async () => ({
      default: { provider: "codex", model: "test" },
      groups: [{ id: "codex", models: [{ id: "test" }] }],
      routableProviders: ["codex"],
      failures: [],
    }),
    adapter: async () => ({
      harnessId: "codex",
      inspect: async () => ({ status: "unavailable", error: { message: "test" } }),
      open: async () => {
        opens++;
        return { ok: true, value: session };
      },
      close: async () => {},
    }),
  };
  const owner = new IsolatedSessions(
    data,
    harnesses,
    { get: () => undefined, ownerOf: () => undefined, attachSession: () => {} },
    {
      changed: () => {},
      interaction: () => {
        throw Error("unexpected");
      },
    },
    { idleReleaseMs: 5 },
  );
  await owner.create({ sessionId: "session", cwd: "/workspace" });
  owner.prompt({
    request: {
      sessionId: "session",
      requestId: "one",
      content: [{ type: "text", text: "first" }],
      mode: "queue",
    },
  });
  const deadline = Date.now() + 1000;
  while (closes === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(closes, 1);
  owner.prompt({
    request: {
      sessionId: "session",
      requestId: "two",
      content: [{ type: "text", text: "second" }],
      mode: "queue",
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opens, 1);
  assert.equal(starts, 1);
  const events = data.readLines<{ type: string; data: unknown }>("sessions/session/events.jsonl");
  assert.match(JSON.stringify(events.at(-1)), /release-unconfirmed/);
  stopped = true;
  wake?.();
  await assert.rejects(owner.close(), /shutdown was not confirmed/);
});

test("shutdown waits for a delayed native open and closes it without starting input", async () => {
  const files = new Map<string, unknown>();
  const data: SessionDataStore = {
    path: (...parts) => parts.join("/"),
    readJson: <T>(key: string, fallback: T) => (files.get(key) ?? fallback) as T,
    writeJson: (key, value) => {
      files.set(key, structuredClone(value));
    },
    readLines: <T>(key: string) => (files.get(key) ?? []) as T[],
    writeLines: (key, value) => {
      files.set(key, [...value]);
    },
    appendLine: (key, value) => {
      files.set(key, [...((files.get(key) ?? []) as unknown[]), value]);
    },
  };
  const opened = Promise.withResolvers<undefined>();
  const releaseOpen = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<undefined>();
  let starts = 0;
  let closes = 0;
  const session: HarnessSessionLike = {
    harnessId: "codex",
    capabilities: {},
    initialState: {
      nativeRef: {
        harnessId: "codex",
        nativeSessionId: "late",
        locator: { codexHome: "/isolated" },
      },
    },
    initialUsage: null,
    outputs: {
      async *[Symbol.asyncIterator]() {
        await closed.promise;
      },
    },
    execute: async () => {
      starts++;
      return { ok: true, value: {} };
    },
    readSnapshot: async () => ({ ok: true, value: { turns: [] } }),
    close: async () => {
      closes++;
      closed.resolve(undefined);
    },
  };
  const inspect = async () => ({ status: "unavailable" as const, error: { message: "test" } });
  const harnesses: SessionHarnesses = {
    ids: () => ["codex"],
    manifest: () => ({ name: "Codex" }),
    preferredSelection: undefined,
    inspect,
    modelCatalog: async () => ({
      default: { provider: "codex", model: "test" },
      groups: [{ id: "codex", models: [{ id: "test" }] }],
      routableProviders: ["codex"],
      failures: [],
    }),
    adapter: async () => ({
      harnessId: "codex",
      inspect,
      close: async () => {},
      open: async () => {
        opened.resolve(undefined);
        await releaseOpen.promise;
        return { ok: true, value: session };
      },
    }),
  };
  const owner = new IsolatedSessions(
    data,
    harnesses,
    { get: () => undefined, ownerOf: () => undefined, attachSession: () => {} },
    {
      changed: () => {},
      interaction: () => {
        throw Error("unexpected");
      },
    },
  );
  await owner.create({ sessionId: "late", cwd: "/workspace" });
  await owner.prompt({
    request: {
      sessionId: "late",
      requestId: "one",
      content: [{ type: "text", text: "input" }],
      mode: "queue",
    },
  });
  await opened.promise;
  let finished = false;
  const shutdown = owner.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  releaseOpen.resolve(undefined);
  await shutdown;
  assert.equal(closes, 1);
  assert.equal(starts, 0);
  await assert.rejects(
    owner.prompt({ request: { sessionId: "late", requestId: "two", content: [], mode: "queue" } }),
    /Sessions are closing/,
  );
});
