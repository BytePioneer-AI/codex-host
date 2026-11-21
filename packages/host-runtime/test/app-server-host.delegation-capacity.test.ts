import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("AppServerHost delegation capacity", () => {
  it("reports the setting as unavailable when no delegation registry is attached", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/delegation-capacity/set",
        params: { enabled: true, maxRunning: 2 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 900))).toMatchObject({
        error: { code: -32601 },
      });
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("queues a top-level client delegation while a manually opened Thread runs, and starts session-parented child delegations immediately", async () => {
    const registry = new DelegationControlRegistry({ capacity: { pollIntervalMs: 10 } });
    let registration: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        registration = api;
        return registry.register(api);
      },
    });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/delegation-capacity/set",
        params: { enabled: true, maxRunning: 0 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 900))).toMatchObject({
        error: { code: -32602 },
      });
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "codexhost/settings/delegation-capacity/set",
        params: { enabled: true, maxRunning: 1 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 901))).toMatchObject({
        result: { enabled: true, maxRunning: 1 },
      });
      expect(fixture.official.stdin.read()).toBeNull();

      const manual = await startPiThread(fixture);
      const manualTurn = await startPiTurn(fixture, manual);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", manualTurn));

      // A child session spawned by an existing session bypasses the top-level queue and does not count as top-level.
      const child = await registry.start({
        harnessId: "pi",
        task: "child work",
        cwd: "/synthetic",
        parentThreadId: manual,
      });
      expect(child).toMatchObject({ harnessId: "pi", status: "running", parentThreadId: manual });
      expect(fixture.adapter.sessions).toHaveLength(2);
      expect(registration?.runningThreadIds?.()).toEqual([manual]);

      const queued = await registry.start({
        harnessId: "pi",
        task: "queued work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(queued).toMatchObject({ harnessId: "pi", status: "queued", queue: { position: 1 } });
      expect(fixture.adapter.sessions).toHaveLength(2);
      expect(await registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
        status: "queued",
        queue: { position: 1 },
      });

      const manualSession = fixture.adapter.sessions[0];
      if (!manualSession) throw new Error("Missing manual Session");
      manualSession.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", manualTurn),
      );
      // Even while `child` is still running, ending `manual` frees the top-level slot for `queued`.
      await vi.waitFor(() => expect(fixture.adapter.sessions).toHaveLength(3), { timeout: 5_000 });
      await vi.waitFor(async () =>
        expect(await registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
          threadId: queued.threadId,
          status: "running",
        }),
      );
      expect(registration?.runningThreadIds?.()).toEqual([queued.threadId]);
      expect(await fixture.mappingStore.getThread(queued.threadId as never)).toMatchObject({
        hostThreadId: queued.threadId,
      });

      // The limit is reached again, yet a follow-up message to an existing Thread still starts.
      const followUp = await registry.send({ threadId: manual, message: "follow up" });
      expect(followUp).toMatchObject({ threadId: manual, status: "running" });
      const next = await registry.start({
        harnessId: "pi",
        task: "next work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(next).toMatchObject({ status: "queued", queue: { position: 1 } });
      expect(await registry.cancel({ threadId: next.threadId })).toMatchObject({ cancelled: true });

      manualSession.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", followUp.turnId),
      );
      fixture.adapter.sessions[1]?.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", child.turnId),
      );
      fixture.adapter.sessions[2]?.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", queued.turnId),
      );
      expect(fixture.adapter.sessions).toHaveLength(3);
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });

  it("counts running native top-level Threads but not native subagents or Fork children", async () => {
    const registry = new DelegationControlRegistry({ capacity: { pollIntervalMs: 10 } });
    let registration: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        registration = api;
        return registry.register(api);
      },
    });
    const official = (method: string, params: JsonObject) =>
      fixture.official.stdout.write(`${JSON.stringify({ method, params })}\n`);
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/delegation-capacity/set",
        params: { enabled: true, maxRunning: 1 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      official("thread/started", {
        thread: {
          id: "native-sub",
          source: { subAgent: { thread_spawn: { parent_thread_id: "native-top", depth: 1 } } },
        },
      });
      official("thread/started", {
        thread: {
          id: "native-fork",
          forkedFromId: "native-top",
        },
      });
      official("turn/started", { threadId: "native-sub", turn: { id: "sub-turn" } });
      official("turn/started", { threadId: "native-fork", turn: { id: "fork-turn" } });
      official("turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(registration?.runningThreadIds?.()).toEqual(["native-top"]));

      const queued = await registry.start({
        harnessId: "pi",
        task: "queued work",
        cwd: "/synthetic",
        parentThreadId: "client:claude-desktop",
      });
      expect(queued).toMatchObject({ status: "queued", queue: { position: 1 } });
      expect(fixture.adapter.sessions).toHaveLength(0);

      // Only the subagent and Fork child keep running, and neither holds the top-level slot.
      official("turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await vi.waitFor(() => expect(fixture.adapter.sessions).toHaveLength(1), { timeout: 5_000 });
      await vi.waitFor(async () =>
        expect(await registry.read({ threadId: queued.threadId, view: "result" })).toMatchObject({
          status: "running",
        }),
      );
      expect(registration?.runningThreadIds?.()).toEqual([queued.threadId]);
      fixture.adapter.sessions[0]?.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", queued.turnId),
      );
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });
});
