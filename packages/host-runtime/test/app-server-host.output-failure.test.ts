import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HarnessSession } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import * as attachments from "../src/external-inline-attachments.js";
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

  it("resumes the native Session for the next Turn after a successful Turn and EOF", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const first = await startPiTurn(fixture, threadId);
      const { adapter } = fixture;
      const session = adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.succeedTurn();
      expect(
        await fixture.collector.waitFor((msg) => turnEvent(msg, "turn/completed", first)),
      ).toMatchObject({ params: { turn: { status: "completed" } } });
      await session.close();

      const restored = new FakeHarnessSession(
        adapter.harnessId,
        adapter.catalog,
        undefined,
        session.initialState.nativeRef,
        session.persistedSnapshot(),
        true,
        session.cwd,
      );
      const open = vi.spyOn(adapter, "open").mockResolvedValueOnce({ ok: true, value: restored });
      const staleExecute = vi.spyOn(session, "execute");
      const next = await startPiTurn(fixture, threadId, 3);
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "resume",
          nativeRef: session.initialState.nativeRef,
        }),
      );
      expect(staleExecute).not.toHaveBeenCalled();
      restored.succeedTurn();
      expect(
        await fixture.collector.waitFor((msg) => turnEvent(msg, "turn/completed", next)),
      ).toMatchObject({ params: { turn: { status: "completed" } } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["image", "mapping"])(
    "rejects a Turn when output ends during %s preparation",
    async (stage) => {
      const fixture = createFixture();
      const materialize = attachments.materializeExternalImages;
      const prepare = vi.spyOn(attachments, "materializeExternalImages");
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Fake Pi Session was not opened");
        const execute = vi.spyOn(session, "execute");
        const close = async () => {
          await session.close();
          await new Promise<void>((resolve) => setImmediate(resolve));
        };
        prepare.mockImplementationOnce(async (input, env) => {
          if (stage === "image") await close();
          else {
            const read = fixture.mappingStore.getThread.bind(fixture.mappingStore);
            vi.spyOn(fixture.mappingStore, "getThread").mockImplementationOnce(async (id) => {
              await close();
              return read(id);
            });
          }
          return materialize(input, env);
        });
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: "turn/start",
          params: {
            threadId,
            input: [
              { type: "text", text: "inspect" },
              { type: "image", url: "data:image/png;base64,Ag==" },
            ],
          },
        });
        expect(await fixture.collector.waitFor((msg) => requestId(msg, 2))).toMatchObject({
          error: { code: -32073, message: expect.stringContaining("no longer available") },
        });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        await stopFixture(fixture);
      }
    },
  );

  const parentEndings = [
    { parent: "active", ending: "EOF", error: "output ended before the active Turn settled" },
    { parent: "active", ending: "error", error: "Parent output failed" },
    { parent: "settled", ending: "EOF" },
    { parent: "settled", ending: "error" },
  ] as const;
  it.each(parentEndings)(
    "retires running Subagents after $ending with a $parent parent Turn",
    async (testCase) => {
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
        // End the parent stream without sending a terminal Turn or Session event.
        let outputEnded = false;
        const wrapOutputs = (session: HarnessSession) => {
          const real = session.outputs;
          Object.defineProperty(session, "outputs", {
            value: {
              [Symbol.asyncIterator]() {
                const inner = real[Symbol.asyncIterator]();
                return {
                  next: async () => {
                    const output = await inner.next();
                    if (outputEnded) {
                      if (testCase.ending === "error") throw new Error("Parent output failed");
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

        // The native child has not reported a terminal state, even if its spawn Item completes.
        const subagentItemId = session.startSubagentDelegation({
          subagentId: "call-child",
          nativeSubagentId: "native-child",
          description: "Child worker",
          background: true,
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

        const settled = testCase.parent === "settled";
        if (settled) {
          session.completeItem(subagentItemId, { status: "succeeded" });
          session.succeedTurn();
          await fixture.collector.waitFor((message) =>
            turnEvent(message, "turn/completed", turnId),
          );
        }

        // Queue a follow-up while the parent is still active, even after a successful Turn.
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
        const queuedItems = [
          expect.objectContaining({ input: [{ type: "text", text: "queued" }] }),
        ];
        expect((await fixture.host.clientSnapshot(threadId)).queue).toMatchObject({
          items: queuedItems,
          pausedReason: null,
        });
        const beforeOutputEnd = fixture.collector.messages.length;
        for (const id of [threadId, childId]) {
          expect(
            fixture.collector.messages.some((message) => threadStatus(message, id, "idle")),
          ).toBe(false);
        }

        // Wake the iterator; it discards this Item and ends or throws instead.
        outputEnded = true;
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

        const snapshot = await fixture.host.clientSnapshot(threadId);
        const messages = fixture.collector.messages;
        const completions = messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({
          params: {
            turn: settled
              ? { status: "completed" }
              : { status: "failed", error: { message: expect.stringContaining(testCase.error) } },
          },
        });
        // Only an unfinished Turn publishes a failure pause. Neither path starts the follow-up.
        expect(
          messages
            .slice(beforeOutputEnd)
            .filter(
              (message) =>
                method(message, "thread/queue/changed") &&
                messageParams(message).threadId === threadId,
            ),
        ).toHaveLength(settled ? 0 : 1);
        expect(messages.filter((message) => method(message, "turn/started"))).toHaveLength(1);
        expect(snapshot.queue).toMatchObject({
          items: queuedItems,
          pausedReason: settled ? null : "failed",
        });
      } finally {
        await stopFixture(fixture);
      }
    },
  );
});
