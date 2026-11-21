import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import type { PersistedQueuedDelegation } from "../src/delegation-capacity-store.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import {
  createFixture,
  readJsonLine,
  requestId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

/**
 * Answers the Host's requests to the native backend; `turns` holds each Thread's Turn
 * IDs, and a Turn start in a Thread listed in `refuse` is answered with an error.
 */
function serveOfficial(fixture: Fixture, threadIds: string[]) {
  const seen: JsonObject[] = [];
  const turns = new Map<string, string[]>();
  const refuse = new Set<string>();
  let stopped = false;
  let nextTurn = 0;
  const answer = (request: JsonObject): JsonObject => {
    const params = (request.params ?? {}) as JsonObject;
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (request.method === "turn/start" && refuse.has(threadId)) {
      return { error: { code: -32000, message: "synthetic refusal" } };
    }
    switch (request.method) {
      case "thread/start": {
        const id = threadIds.shift();
        if (!id) throw new Error("No synthetic native Thread left");
        return { thread: { id, cwd: "/synthetic" } };
      }
      case "thread/read":
        return {
          thread: {
            id: threadId,
            cwd: "/synthetic",
            ...(params.includeTurns
              ? { turns: (turns.get(threadId) ?? []).map((id) => ({ id, status: "inProgress" })) }
              : {}),
          },
        };
      case "thread/resume":
        return { thread: { id: threadId, cwd: "/synthetic" } };
      case "turn/start": {
        const id = `turn-${nextTurn++}`;
        turns.set(threadId, [...(turns.get(threadId) ?? []), id]);
        return { turn: { id, status: "inProgress" } };
      }
      default:
        return {};
    }
  };
  const reply = (request: JsonObject): JsonObject => {
    const answered = answer(request);
    return "error" in answered
      ? { id: request.id ?? null, error: answered.error ?? null }
      : { id: request.id ?? null, result: answered };
  };
  const loop = (async () => {
    while (!stopped) {
      let request: JsonObject;
      try {
        request = await readJsonLine(fixture.official.stdin, 50);
      } catch {
        continue;
      }
      seen.push(request);
      if (request.id !== undefined) {
        fixture.official.stdout.write(`${JSON.stringify(reply(request))}\n`);
      }
    }
  })();
  return {
    seen,
    turns,
    refuse,
    calls: (method: string, threadId: string) =>
      seen.filter(
        (entry) =>
          entry.method === method &&
          (entry.params as JsonObject | undefined)?.threadId === threadId,
      ),
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

function official(fixture: Fixture, method: string, params: JsonObject): void {
  fixture.official.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

async function limit(fixture: Fixture, maxRunning: number, id = 900): Promise<void> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "codexhost/settings/delegation-capacity/set",
    params: { enabled: true, maxRunning },
  });
  await fixture.collector.waitFor((message) => requestId(message, id));
}

function setup(store?: {
  adopt(): Promise<PersistedQueuedDelegation[]>;
  save(entries: readonly PersistedQueuedDelegation[]): Promise<void>;
}) {
  const registry = new DelegationControlRegistry({
    capacity: { pollIntervalMs: 10, ...(store ? { store } : {}) },
  });
  let registration: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    onDelegationApi: (api) => {
      registration = api;
      return registry.register(api);
    },
  });
  return { registry, fixture, running: () => registration?.runningThreadIds?.() ?? [] };
}

describe("AppServerHost native delegation capacity", () => {
  it("queues top-level native Codex starts in Threads created up front, while starting session-parented child delegations immediately", async () => {
    const { registry, fixture, running } = setup();
    const backend = serveOfficial(fixture, [
      "child-native",
      "queued-native",
      "second-native",
      "third-native",
    ]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));

      // A session-parented native child delegation bypasses the top-level queue and does not count toward running().
      const child = await registry.start({
        harnessId: "codex",
        task: "child native work",
        cwd: "/synthetic",
        parentThreadId: "native-top",
      });
      expect(child).toMatchObject({
        threadId: "child-native",
        harnessId: "codex",
        status: "running",
        parentThreadId: "native-top",
      });
      official(fixture, "turn/started", { threadId: "child-native", turn: { id: "child-turn" } });
      expect(running()).toEqual(["native-top"]);

      const first = await registry.start({
        harnessId: "codex",
        task: "queued native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(first).toMatchObject({
        threadId: "queued-native",
        harnessId: "codex",
        deepLink: "codex://threads/queued-native",
        status: "queued",
        queue: { position: 1 },
      });
      expect(
        await fixture.mappingStore.getDelegationByChild("queued-native" as never),
      ).toMatchObject({
        parentHostThreadId: "client:claude-desktop",
        childHostThreadId: "queued-native",
        status: "creating",
      });
      expect(backend.calls("thread/name/set", "queued-native")).toHaveLength(1);
      const second = await registry.start({
        harnessId: "codex",
        task: "second native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(second).toMatchObject({ threadId: "second-native", queue: { position: 2 } });
      // A retry of a waiting start returns it without creating another Thread.
      expect(
        await registry.start({
          harnessId: "codex",
          task: "second native work",
          cwd: "/synthetic",
          parentThreadId: "client:claude-desktop",
        }),
      ).toMatchObject({ threadId: "second-native", status: "queued", queue: { position: 2 } });
      expect(backend.seen.filter((entry) => entry.method === "thread/start")).toHaveLength(3);
      expect(backend.calls("turn/start", "queued-native")).toHaveLength(0);
      expect(backend.calls("turn/start", "second-native")).toHaveLength(0);

      expect(await registry.read({ threadId: "queued-native", view: "result" })).toMatchObject({
        status: "queued",
        queue: { position: 1 },
      });
      await expect(
        registry.send({ threadId: "queued-native", message: "more" }),
      ).rejects.toMatchObject({ code: "THREAD_BUSY" });

      expect(await registry.cancel({ threadId: "second-native" })).toMatchObject({
        cancelled: true,
      });
      // Checked for a Turn first; the empty Thread is left in place.
      expect(backend.calls("thread/read", "second-native")).toMatchObject([
        { params: { includeTurns: true } },
      ]);
      expect(backend.seen.some((entry) => entry.method === "thread/delete")).toBe(false);
      expect(await registry.read({ threadId: "second-native", view: "result" })).toMatchObject({
        status: "interrupted",
      });
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "thread/resume",
        params: {
          threadId: "second-native",
          initialTurnsPage: { limit: 10, itemsView: "full" },
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 910))).toMatchObject({
        result: {
          thread: {
            id: "second-native",
            turns: [
              {
                status: "interrupted",
                items: [
                  { type: "userMessage", content: [{ text: "second native work" }] },
                  { type: "agentMessage" },
                ],
              },
            ],
          },
          initialTurnsPage: {
            data: [
              {
                status: "interrupted",
                items: [
                  { type: "userMessage", content: [{ text: "second native work" }] },
                  { type: "agentMessage" },
                ],
              },
            ],
          },
        },
      });

      official(fixture, "turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await vi.waitFor(() => expect(running()).toEqual(["queued-native"]), { timeout: 5_000 });
      expect(backend.calls("thread/resume", "queued-native")).toHaveLength(1);
      expect(backend.calls("turn/start", "queued-native")).toMatchObject([
        {
          params: {
            threadId: "queued-native",
            input: [{ type: "text", text: "queued native work" }],
          },
        },
      ]);
      // The identity returned while queued now reads the native Thread itself.
      await vi.waitFor(async () =>
        expect(await registry.read({ threadId: "queued-native", view: "result" })).toMatchObject({
          threadId: "queued-native",
          harnessId: "codex",
          status: "running",
        }),
      );
      expect(await registry.capacity.claim("queued-native", "codex")).toBeUndefined();

      // The slot is taken again; the next top-level native start waits behind it.
      const third = await registry.start({
        harnessId: "codex",
        task: "third native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(third).toMatchObject({ threadId: "third-native", status: "queued" });
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("starts the queued task with a user message sent to the waiting Thread, only once", async () => {
    const { registry, fixture, running } = setup();
    const backend = serveOfficial(fixture, ["claimed-native"]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));
      const queued = await registry.start({
        harnessId: "codex",
        task: "queued native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(queued).toMatchObject({ threadId: "claimed-native", status: "queued" });

      writeRequest(fixture.desktopInput, {
        id: 950,
        method: "turn/start",
        params: { threadId: "claimed-native", input: [{ type: "text", text: "user message" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 950))).toMatchObject({
        result: { turn: { id: "turn-0" } },
      });
      expect(backend.calls("turn/start", "claimed-native")).toMatchObject([
        {
          params: {
            input: [
              { type: "text", text: "queued native work" },
              { type: "text", text: "user message" },
            ],
          },
        },
      ]);
      expect(await registry.capacity.claim("claimed-native", "codex")).toBeUndefined();

      official(fixture, "turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(backend.calls("turn/start", "claimed-native")).toHaveLength(1);
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("keeps a queued start in its place when the backend refuses the user's Turn", async () => {
    const { registry, fixture, running } = setup();
    const backend = serveOfficial(fixture, ["refused-native"]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));
      await registry.start({
        harnessId: "codex",
        task: "queued native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      backend.refuse.add("refused-native");
      writeRequest(fixture.desktopInput, {
        id: 960,
        method: "turn/start",
        params: { threadId: "refused-native", input: [{ type: "text", text: "user message" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 960))).toMatchObject({
        error: { message: "synthetic refusal" },
      });
      await vi.waitFor(async () =>
        expect(await registry.read({ threadId: "refused-native", view: "result" })).toMatchObject({
          status: "queued",
          queue: { position: 1 },
        }),
      );

      backend.refuse.clear();
      official(fixture, "turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await vi.waitFor(() => expect(running()).toEqual(["refused-native"]), { timeout: 5_000 });
      expect(backend.calls("turn/start", "refused-native").at(-1)).toMatchObject({
        params: { input: [{ type: "text", text: "queued native work" }] },
      });
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("keeps the user's message when a cancel and the message cross", async () => {
    const gate = { block: false, release: (): void => undefined };
    const { registry, fixture, running } = setup({
      adopt: async () => [],
      save: async () => {
        if (!gate.block) return;
        gate.block = false;
        await new Promise<void>((resolve) => (gate.release = resolve));
      },
    });
    const backend = serveOfficial(fixture, ["crossed-native"]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));
      await registry.start({
        harnessId: "codex",
        task: "queued native work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      gate.block = true;
      const cancelling = registry.cancel({ threadId: "crossed-native" });
      await vi.waitFor(() => expect(gate.block).toBe(false));
      // The cancel has taken the start out of the queue and is storing that.
      writeRequest(fixture.desktopInput, {
        id: 970,
        method: "turn/start",
        params: { threadId: "crossed-native", input: [{ type: "text", text: "user message" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 970))).toMatchObject({
        result: { turn: { id: "turn-0" } },
      });
      gate.release();
      expect(await cancelling).toMatchObject({ cancelled: true });

      expect(backend.calls("turn/start", "crossed-native")).toMatchObject([
        { params: { input: [{ type: "text", text: "user message" }] } },
      ]);
      expect(backend.seen.some((entry) => entry.method === "thread/delete")).toBe(false);
      expect(backend.turns.get("crossed-native")).toEqual(["turn-0"]);
      // The delegation was cancelled; the Thread reads as what it holds, the user's Turn.
      expect(await registry.read({ threadId: "crossed-native", view: "result" })).toMatchObject({
        turn: { turnId: "turn-0" },
      });
      expect(await registry.capacity.claim("crossed-native", "codex")).toBeUndefined();
    } finally {
      gate.release();
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("adopts a restored native start whose Turn already began, and starts the rest", async () => {
    const saved: (readonly PersistedQueuedDelegation[])[] = [];
    const { registry, fixture, running } = setup({
      adopt: async () => [
        stored("begun-native", "begun work", true),
        stored("waiting-native", "waiting work"),
      ],
      save: async (entries) => {
        saved.push(entries);
      },
    });
    const backend = serveOfficial(fixture, []);
    backend.turns.set("begun-native", ["begun-turn"]);
    try {
      await fixture.ready;
      // Read before the setting arrives: the Thread is checked, not reported as waiting.
      const begun = await registry.read({ threadId: "begun-native", view: "result" });
      expect(begun).toMatchObject({ threadId: "begun-native", turn: { turnId: "begun-turn" } });
      expect(begun).not.toHaveProperty("queue");
      expect(await registry.read({ threadId: "waiting-native", view: "result" })).toMatchObject({
        status: "queued",
        queue: { position: 1 },
      });
      await limit(fixture, 4);
      await vi.waitFor(() => expect(running()).toEqual(["waiting-native"]), { timeout: 5_000 });
      expect(backend.calls("thread/resume", "begun-native")).toHaveLength(1);
      expect(backend.calls("turn/start", "begun-native")).toHaveLength(0);
      expect(backend.calls("turn/start", "waiting-native")).toMatchObject([
        { params: { input: [{ type: "text", text: "waiting work" }] } },
      ]);
      await vi.waitFor(() => expect(saved.at(-1)).toEqual([]));
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("cancels a restored native start whose Turn began as a started one, keeping its Thread", async () => {
    const { registry, fixture } = setup({
      adopt: async () => [stored("begun-native", "begun work", true)],
      save: async () => undefined,
    });
    const backend = serveOfficial(fixture, []);
    backend.turns.set("begun-native", ["begun-turn"]);
    try {
      await fixture.ready;
      expect(await registry.cancel({ threadId: "begun-native" })).toMatchObject({
        threadId: "begun-native",
        turnId: "begun-turn",
        cancelled: true,
      });
      expect(backend.calls("turn/interrupt", "begun-native")).toHaveLength(1);
      expect(backend.seen.some((entry) => entry.method === "thread/delete")).toBe(false);
      expect(backend.calls("turn/start", "begun-native")).toHaveLength(0);
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("sends a user message to a restored native start whose Turn began without the task", async () => {
    const { registry, fixture } = setup({
      adopt: async () => [stored("begun-native", "begun work", true)],
      save: async () => undefined,
    });
    const backend = serveOfficial(fixture, []);
    backend.turns.set("begun-native", ["begun-turn"]);
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 980,
        method: "turn/start",
        params: { threadId: "begun-native", input: [{ type: "text", text: "user follow-up" }] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 980));
      expect(backend.calls("turn/start", "begun-native")).toMatchObject([
        { params: { input: [{ type: "text", text: "user follow-up" }] } },
      ]);
      expect(await registry.capacity.claim("begun-native", "codex")).toBeUndefined();
      expect(await registry.read({ threadId: "begun-native", view: "result" })).toMatchObject({
        status: "running",
      });
    } finally {
      await registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });
});

function stored(threadId: string, task: string, starting?: boolean): PersistedQueuedDelegation {
  return {
    delegationId: `delegation-${threadId}`,
    threadId,
    turnId: "pending",
    harnessId: "codex",
    task,
    cwd: "/synthetic",
    parentThreadId: "client:claude-desktop",
    title: task,
    taskDigest: createHash("sha256").update(task).digest("hex"),
    queuedAt: Date.now(),
    ...(starting ? { starting } : {}),
  };
}
