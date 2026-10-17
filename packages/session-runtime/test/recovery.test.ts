import { expect, it } from "vitest";
import { IsolatedSessions, type SessionDataStore, type SessionHarnesses } from "../src/index.js";

it("retire persisted queue views on restart without replaying or resuming native input", async () => {
  const files = new Map<string, unknown>([
    [
      "sessions/index.json",
      {
        session: {
          sessionId: "session",
          cwd: "/workspace",
          createdAt: 1,
          updatedAt: 2,
          blank: false,
          harnessId: "codex",
          nativeRef: { harnessId: "codex", nativeSessionId: "native" },
        },
      },
    ],
    [
      "sessions/session/projections.json",
      {
        inbox: {
          "next-turn": [{ id: "queued", content: [{ type: "text", text: "do not replay" }] }],
          "next-step": [],
        },
        queueState: { pausedReason: "old" },
      },
    ],
    ["sessions/session/events.jsonl", [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]],
  ]);
  const data: SessionDataStore = {
    path: (...parts) => parts.join("/"),
    readJson: <T>(key: string, fallback: T) => structuredClone((files.get(key) ?? fallback) as T),
    writeJson: (key, value) => {
      files.set(key, structuredClone(value));
    },
    readLines: <T>(key: string) => structuredClone((files.get(key) ?? []) as T[]),
    writeLines: (key, value) => {
      files.set(key, structuredClone([...value]));
    },
    appendLine: (key, value) => {
      files.set(key, [...((files.get(key) ?? []) as unknown[]), structuredClone(value)]);
    },
  };
  let opens = 0;
  const harnesses: SessionHarnesses = {
    ids: () => ["codex"],
    manifest: () => ({ name: "Codex" }),
    preferredSelection: undefined,
    modelCatalog: async () => ({
      default: { provider: "codex", model: "test" },
      groups: [],
      routableProviders: [],
      failures: [],
    }),
    inspect: async () => ({ status: "unavailable", error: { message: "test" } }),
    adapter: async () => {
      opens++;
      throw new Error("Read-only recovery must not open a native session");
    },
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
  const cold = owner.list().items[0] as {
    running: boolean;
    projections: { values: Record<string, unknown> };
  };
  expect(cold.running).toBe(false);
  expect(cold.projections.values.inbox).toEqual({ "next-turn": [], "next-step": [] });
  expect(cold.projections.values.queueState).toEqual({ pausedReason: null });
  const frames: unknown[] = [];
  owner.control(
    {},
    {
      id: "test",
      closed: false,
      push: (frame) => frames.push(frame),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const baseline = frames[0] as {
    value: { projections: { session: { values: Record<string, unknown> } } };
  };
  expect(baseline.value.projections.session.values.inbox).toEqual({
    "next-turn": [],
    "next-step": [],
  });
  const loaded = owner.projections({ sessionId: "session" });
  expect(loaded?.values.inbox).toEqual({ "next-turn": [], "next-step": [] });
  expect(
    data
      .readLines<{ type: string; data: { reason?: { kind: string } } }>(
        "sessions/session/events.jsonl",
      )
      .at(-1),
  ).toMatchObject({ type: "turn/end", data: { reason: { kind: "interrupted" } } });
  expect(owner.activity().queuedPrompts).toBe(0);
  expect(opens).toBe(0);
  await owner.close();
});
