import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HarnessSession } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  messageParams,
  method,
  readJsonLine,
  requestId,
  requiredMessageId,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("AppServerHost output failure", () => {
  it("finishes when Desktop output closes during a backpressured initialize response", async () => {
    const fixture = createFixture({ desktopOutput: new PassThrough({ highWaterMark: 1 }) });
    try {
      await fixture.ready;
      fixture.desktopOutput.pause();
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params: {} });
      const request = await readJsonLine(fixture.official.stdin);
      expect(request.method).toBe("initialize");
      writeRequest(fixture.official.stdout, { id: requiredMessageId(request), result: {} });
      await vi.waitFor(() => expect(fixture.desktopOutput.writableNeedDrain).toBe(true));
      fixture.desktopOutput.destroy();
      await expect(fixture.running).resolves.toBe(1);
      expect(fixture.desktopInput.destroyed).toBe(true);
      expect(fixture.desktopOutput.listenerCount("close")).toBe(0);
    } finally {
      fixture.host.close();
      fixture.desktopOutput.resume();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("diagnoses duplicate starts with Harness, Thread and Item identity without tool input", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      const item = {
        type: "toolExecution" as const,
        itemId: hostItemIdSchema.parse("replayed-tool"),
        toolName: "Read",
        arguments: { prompt: "private tool input" },
      };
      session.emitEvent({ type: "item.started", turnId, item });
      session.emitEvent({ type: "item.started", turnId, item });
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: expect.stringContaining("Host Item started more than once") },
          },
        },
      });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      const diagnostic = fixture.diagnosticOutput.read()?.toString() ?? "";
      expect(diagnostic).toContain(
        `External Harness output failed (harnessId=pi, threadId=${threadId}): Host Item started more than once (replayed-tool: existing toolExecution, incoming toolExecution)`,
      );
      expect(diagnostic).not.toContain("private tool input");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("fails the Turn and closes its Session when an Item changes type at completion", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [{ id: "auto", label: "Auto" }],
      defaultModeId: "auto",
    });
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      const itemId = hostItemIdSchema.parse("conflicting-item");
      session.emitEvent({
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId, text: "Thinking" },
      });
      session.emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "agentMessage", itemId, text: "Done" },
          outcome: { status: "succeeded" },
        },
      });
      // A bad Item must not leave the Host running or let a later success hide the failure.
      session.succeedTurn();
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: expect.stringContaining("Host Item changed type") },
          },
        },
      });
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
      expect(close).toHaveBeenCalledOnce();
      expect(
        fixture.collector.messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        ),
      ).toHaveLength(1);
      expect(fixture.collector.messages).toContainEqual(
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({ id: `${itemId}-summary`, type: "reasoning" }),
          }),
        }),
      );
      // Configuration must resume the native identity, not execute on the closed Session.
      const execute = vi.spyOn(session, "execute");
      const nativeOpen = adapter.open.bind(adapter);
      const open = vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return nativeOpen(input);
        const restored = new FakeHarnessSession(
          adapter.harnessId,
          adapter.catalog,
          undefined,
          input.nativeRef,
          undefined,
          true,
          input.cwd,
          true,
          undefined,
          null,
          permissionModes,
        );
        return { ok: true, value: restored };
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/thread/permission-mode/select",
        params: { threadId, permissionModeId: "auto" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { effectivePermissionModeId: "auto" },
      });
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "resume",
          nativeRef: session.initialState.nativeRef,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      const otherThread = await startExternalThread(fixture, "codexhost/pi-native", 4);
      const otherTurn = await startPiTurn(fixture, otherThread, 5);
      const otherSession = fixture.adapter.sessions[1];
      if (!otherSession) throw new Error("Other Pi Session was not opened");
      otherSession.succeedTurn();
      expect(
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", otherTurn),
        ),
      ).toMatchObject({
        params: { turn: { status: "completed" } },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("settles the active Turn when the Harness output stream ends without a terminal event", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [{ id: "auto", label: "Auto" }],
      defaultModeId: "auto",
    });
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      // Wrap each opened Session's output stream so it can be ended without a
      // terminal Turn event, mimicking a natively killed Harness subagent.
      const kills: Array<{ killed: boolean }> = [];
      const wrapOutputs = (session: HarnessSession) => {
        const real = session.outputs;
        const state = { killed: false };
        kills.push(state);
        Object.defineProperty(session, "outputs", {
          value: {
            [Symbol.asyncIterator]() {
              const inner = real[Symbol.asyncIterator]();
              return {
                next: async () => {
                  if (state.killed) return { done: true as const, value: undefined };
                  const output = await inner.next();
                  if (state.killed) return { done: true as const, value: undefined };
                  return output;
                },
              };
            },
          },
        });
      };
      const nativeOpen = adapter.open.bind(adapter);
      vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        // Resume of a natively killed Session must open a fresh native process.
        if (input.kind === "resume") {
          const restored = new FakeHarnessSession(
            adapter.harnessId,
            adapter.catalog,
            undefined,
            input.nativeRef,
            undefined,
            true,
            input.cwd,
            true,
            undefined,
            null,
            permissionModes,
          );
          wrapOutputs(restored);
          return { ok: true, value: restored };
        }
        const result = await nativeOpen(input);
        if (result.ok) wrapOutputs(result.value);
        return result;
      });

      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      // End the output stream without emitting turn.completed.
      const kill = kills[0];
      if (!kill) throw new Error("Session output stream was not wrapped");
      kill.killed = true;
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.emitEvent({
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId: hostItemIdSchema.parse("killed-item"), text: "Working" },
      });

      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: expect.stringContaining("output ended") },
          },
        },
      });
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));

      // The Thread must accept a new submission instead of failing with
      // "External Thread already has an active Turn".
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "synthetic" }] },
      });
      const retry = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(retry.error).toBeUndefined();
      const retryTurn = (retry.result as JsonObject).turn as JsonObject;
      expect(typeof retryTurn.id).toBe("string");
    } finally {
      await stopFixture(fixture);
    }
  });

  const endings = ["active EOF", "active error", "settled EOF"] as const;
  it.each(endings)("retires running Subagents after parent output ends (%s)", async (ending) => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [{ id: "auto", label: "Auto" }],
      defaultModeId: "auto",
    });
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      // Wrap each opened Session's output stream before the Host's output pump
      // consumes it, so it can be ended without a terminal Turn event.
      const kill = { killed: false };
      const wrapOutputs = (session: HarnessSession) => {
        const real = session.outputs;
        Object.defineProperty(session, "outputs", {
          value: {
            [Symbol.asyncIterator]() {
              const inner = real[Symbol.asyncIterator]();
              return {
                next: async () => {
                  const output = await inner.next();
                  if (kill.killed) {
                    if (ending === "active error") throw new Error("Parent output failed");
                    return { done: true as const, value: undefined };
                  }
                  return output;
                },
              };
            },
          },
        });
      };
      const nativeOpen = adapter.open.bind(adapter);
      vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        const result = await nativeOpen(input);
        if (result.ok) wrapOutputs(result.value);
        return result;
      });

      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");

      // A running native Subagent is tracked Host-side while the child Session
      // (for example a Claude Code ReadonlySnapshotSession) never ends its own
      // output stream.
      const subagentItemId = session.startSubagentDelegation({
        subagentId: "call-child",
        nativeSubagentId: "native-child",
        description: "Child worker",
        background: false,
        status: "running",
      });
      const childThread = await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
      );
      const child = messageParams(childThread).thread as JsonObject;
      expect(child.status).toMatchObject({ type: "active" });
      const childId = child.id as string;

      if (ending === "settled EOF") {
        session.completeItem(subagentItemId, { status: "succeeded" });
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      }

      // Queue one submission in every path so active failures pause once and
      // settled EOF proves a non-empty queue stays unpaused without auto-starting.
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/queue/add",
        params: { threadId, input: [{ type: "text", text: "queued" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { queuedSubmission: { id: expect.any(String) } },
      });
      await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/queue/changed") && messageParams(message).threadId === threadId,
      );
      expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
        items: [expect.objectContaining({ input: [{ type: "text", text: "queued" }] })],
        pausedReason: null,
      });
      const queueChangesBeforeKill = fixture.collector.messages.filter(
        (message) =>
          method(message, "thread/queue/changed") && messageParams(message).threadId === threadId,
      ).length;

      // Wake the iterator so it ends (or throws) without projecting another Item.
      kill.killed = true;
      session.emitEvent({
        type: "item.started",
        turnId,
        item: {
          type: "reasoning",
          itemId: hostItemIdSchema.parse("killed-parent"),
          text: "Working",
        },
      });

      await fixture.collector.waitFor((message) => threadStatus(message, childId, "idle"));
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
      // Check the final status: failure projection can replay the running Subagent.
      const childStatus = fixture.collector.messages.findLast(
        (message) =>
          method(message, "thread/status/changed") && messageParams(message).threadId === childId,
      );
      expect(childStatus).toMatchObject({ params: { status: { type: "idle" } } });

      // Active failures publish one "failed" pause from the Turn projection without a
      // second "outcome-unknown" pause; settled EOF leaves the queued item unpaused.
      const queueChanges = fixture.collector.messages.filter(
        (message) =>
          method(message, "thread/queue/changed") && messageParams(message).threadId === threadId,
      );
      expect(queueChanges).toHaveLength(
        queueChangesBeforeKill + (ending === "settled EOF" ? 0 : 1),
      );
      expect(
        fixture.collector.messages.filter((message) => method(message, "turn/started")),
      ).toHaveLength(1);
      expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
        items: [expect.objectContaining({ input: [{ type: "text", text: "queued" }] })],
        pausedReason: ending === "settled EOF" ? null : "failed",
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
