import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeClaudeTransportModel,
  encodePiTransportModel,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";

import {
  method,
  requestId,
  messageParams,
  threadStatus,
  turnEvent,
  writeRequest,
  readJsonLine,
  createFixture,
  startExternalThread,
  startPiThread,
  startPiTurn,
  completePiTurn,
  stopFixture,
  bindOfficialThread,
} from "./app-server-host-fixture.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("tail-Forks the latest completed Checkpoint while the source Turn is active", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    const activeTurnId = await startPiTurn(fixture, threadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse).toMatchObject({ result: { thread: { turns: [{}] } } });
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: derivedId, turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();

    const source = fixture.adapter.sessions[0];
    source?.appendText("done");
    source?.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("rejects unsafe external Fork overrides without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, threadId, 2);

    const invalidForks: Array<{ id: number; params: JsonObject; code: number }> = [
      { id: 10, params: { path: "/another/session.jsonl" }, code: -32602 },
      { id: 11, params: { beforeTurnId: firstTurnId }, code: -32080 },
      { id: 12, params: { lastTurnId: "unknown-turn" }, code: -32080 },
      {
        id: 13,
        params: { lastTurnId: firstTurnId, beforeTurnId: firstTurnId },
        code: -32602,
      },
      { id: 14, params: { cwd: "relative-worktree" }, code: -32602 },
      {
        id: 15,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["relative-root"] },
        code: -32602,
      },
      {
        id: 16,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["/source-only"] },
        code: -32602,
      },
    ];
    for (const invalid of invalidForks) {
      writeRequest(fixture.desktopInput, {
        id: invalid.id,
        method: "thread/fork",
        params: { threadId, ...invalid.params },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, invalid.id)),
      ).resolves.toMatchObject({ error: { code: invalid.code } });
    }
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a changed Fork cwd when the Adapter supports only source-cwd Fork", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"), undefined, true, false);
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree"],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects a failed terminal when live Turn identity persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-write-failure-"));
    let failTurnCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failTurnCommit && record.turnMappings.length > 0) {
          throw new Error("synthetic terminal commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    failTurnCommit = true;
    const turnId = await startPiTurn(fixture, threadId, 2);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.appendText("native success");
    session.succeedTurn();

    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
    ).resolves.toMatchObject({
      params: {
        turn: { status: "failed", error: { message: expect.stringContaining("persisted") } },
      },
    });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(threadId))).resolves.toMatchObject(
      {
        turnMappings: [],
      },
    );
    await stopFixture(fixture);
  });

  it("closes and hides a derived runtime when Fork commit fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-fork-failure-"));
    let failForkCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failForkCommit && record.state === "ready" && record.forkSource) {
          throw new Error("synthetic derived commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    const turnId = await completePiTurn(fixture, threadId, 2);
    failForkCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId, lastTurnId: turnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(mappingStore.listThreads()).resolves.toHaveLength(1);
    await stopFixture(fixture);
  });

  it("keeps the temporary derived Session authoritative when rollback commit fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-rollback-failure-"));
    let failRollbackCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failRollbackCommit && record.state === "ready" && record.turnMappings.length === 1) {
          throw new Error("synthetic rollback commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);
    await completePiTurn(fixture, sourceThreadId, 4);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    const before = await mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    failRollbackCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(derivedId))).resolves.toEqual(
      before,
    );
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 12)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}, {}] } } });
    await stopFixture(fixture);
  });

  it("returns the Thread to idle after every Turn in the same Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const turnIds: string[] = [];

    for (const requestIdValue of [2, 3]) {
      const turnId = await startPiTurn(fixture, threadId, requestIdValue);
      turnIds.push(turnId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText(`output ${requestIdValue}`);
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const completedTurnCount = requestIdValue - 1;
      await fixture.collector.waitFor(
        (message) =>
          threadStatus(message, threadId, "idle") &&
          fixture.collector.messages.filter((candidate) =>
            threadStatus(candidate, threadId, "idle"),
          ).length >= completedTurnCount,
      );
    }

    const statuses = fixture.collector.messages.flatMap((message) => {
      if (!method(message, "thread/status/changed")) return [];
      const params = messageParams(message);
      if (params.threadId !== threadId) return [];
      const status = params.status as JsonObject | undefined;
      return typeof status?.type === "string" ? [status.type] : [];
    });
    expect(statuses).toEqual(["active", "idle", "active", "idle"]);
    for (const [turnIndex, turnId] of turnIds.entries()) {
      const completedIndex = fixture.collector.messages.findIndex((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      const idleIndexes = fixture.collector.messages.flatMap((message, messageIndex) =>
        threadStatus(message, threadId, "idle") ? [messageIndex] : [],
      );
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(idleIndexes[turnIndex]).toBeGreaterThan(completedIndex);
    }

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 4)),
    ).resolves.toMatchObject({ result: { thread: { status: { type: "idle" } } } });
    await stopFixture(fixture);
  });

  it("updates a Pi Thread name locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/name/set",
      params: { threadId, name: "Pi Thread" },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/name/updated")),
    ).resolves.toMatchObject({ params: { threadId, threadName: "Pi Thread" } });
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({ result: { thread: { name: "Pi Thread" } } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("deletes an unused Pi prewarm locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const close = vi.spyOn(session, "close");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/delete",
      params: { threadId },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    expect(close).toHaveBeenCalledOnce();
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("deletes an active external Thread after retiring its pending Question", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof questionRequest.id !== "number" || !Number.isSafeInteger(questionRequest.id)) {
      throw new Error("Question request has no numeric Host ID");
    }

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/delete",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    writeRequest(fixture.desktopInput, {
      id: questionRequest.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(questionRequest.id);
    await stopFixture(fixture);
  });

  it("returns a command error without lifecycle notifications for a rejected Turn", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.rejectNextTurn({
      code: "unavailable",
      message: "synthetic rejection",
      retryable: true,
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "rejected" }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32073, message: "synthetic rejection" },
    });
    expect(fixture.collector.messages.some((message) => method(message, "turn/started"))).toBe(
      false,
    );
    await stopFixture(fixture);
  });

  it("projects a visible native failure before the failed Turn terminal", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "failed" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.startReasoning("visible failure context");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.type === "reasoning",
    );
    session.failTurn({
      code: "nativeFailure",
      message: '503: {"message":"Service temporarily unavailable","type":"api_error"}',
      retryable: false,
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "failed",
          error: {
            message: expect.stringContaining("Service temporarily unavailable"),
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      },
    });
    const visibleError = fixture.collector.messages.find((message) => method(message, "error"));
    expect(visibleError).toMatchObject({
      params: {
        error: {
          message: expect.stringContaining("Service temporarily unavailable"),
          codexErrorInfo: "other",
          additionalDetails: null,
        },
        willRetry: false,
        threadId,
      },
    });

    const itemIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "item/completed"),
    );
    const errorIndex = fixture.collector.messages.findIndex((message) => method(message, "error"));
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(itemIndex);
    expect(turnIndex).toBeGreaterThan(errorIndex);
    await stopFixture(fixture);
  });

  it("projects Command, Generic Tool, reliable File Change, and Turn Diff output", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    const commandId = session.startCommandExecution("printf done", "/synthetic");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).item !== undefined &&
        ((message.params as JsonObject).item as JsonObject).id === commandId,
    );
    session.appendCommandOutput(commandId, "done\n");
    await fixture.collector.waitFor((message) =>
      method(message, "item/commandExecution/outputDelta"),
    );
    session.completeItem(commandId, { status: "succeeded" });

    const toolId = session.startToolExecution("custom", { value: 1 });
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "custom output" }],
    });
    session.completeItem(toolId, { status: "succeeded" });
    const toolCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === toolId,
    );
    expect(toolCompleted).toMatchObject({
      params: { item: { type: "dynamicToolCall", tool: "custom", success: true } },
    });

    session.emitFileChange([
      {
        path: "sample.txt",
        kind: "update",
        unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ]);
    await fixture.collector.waitFor((message) => method(message, "item/fileChange/patchUpdated"));
    await expect(
      fixture.collector.waitFor((message) => method(message, "turn/diff/updated")),
    ).resolves.toMatchObject({ params: { diff: expect.stringContaining("+new") } });

    session.appendText("finished");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "completed",
          items: [{ type: "fileChange" }, { type: "agentMessage" }],
        },
      },
    });
    await stopFixture(fixture);
  });

  it("round-trips an early Approval through the reviewed Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApprovalOnNextTurn("Allow native action?", "One-shot approval");

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toEqual({
      id: -1_000_001,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Pi",
        threadId,
        turnId,
        mode: "form",
        message: "Allow native action?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          reason: "One-shot approval",
        },
      },
    });
    expect(
      fixture.collector.messages.some((message) => method(message, "item/tool/requestUserInput")),
    ).toBe(false);

    const approvalRequestId = request.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept", content: {}, _meta: null },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowOnce" } },
      ]);
    });
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.interactionResponses).toHaveLength(1);

    session.appendText("continued");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("round-trips a declared native Approval scope without exposing a payload", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.requestApproval("Remember native action?", undefined, "always");
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toMatchObject({ params: { _meta: { persist: "always" } } });
    if (typeof request.id !== "number") throw new Error("Approval request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { action: "accept", content: {}, _meta: { persist: "always" } },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowAlways" } },
      ]);
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("fails closed for denied, cancelled, errored, and malformed native Approval responses", async () => {
    const responses: JsonObject[] = [
      { result: { action: "decline" } },
      { result: { action: "cancel" } },
      { error: { code: -1, message: "dismissed" } },
      { result: { action: "allowForSession" } },
      { result: { action: "accept", content: {}, _meta: { persist: "session" } } },
    ];
    for (const response of responses) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.requestApproval("Approve once");
      const request = await fixture.collector.waitFor((message) =>
        method(message, "mcpServer/elicitation/request"),
      );
      const approvalRequestId = request.id;
      if (typeof approvalRequestId !== "number") {
        throw new Error("Approval request has no numeric Host ID");
      }
      writeRequest(fixture.desktopInput, { id: approvalRequestId, ...response });
      await vi.waitFor(() => {
        expect(session.interactionResponses.at(-1)).toMatchObject({
          response: { type: "approval", actionId: "deny" },
        });
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("resolves cancelled Approval state and consumes its reserved late-response namespace", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApproval("Cancel pending Approval");
    const approvalRequest = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    const approvalRequestId = approvalRequest.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    const resolved = await fixture.collector.waitFor((message) =>
      method(message, "serverRequest/resolved"),
    );
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(resolved).toMatchObject({
      params: { threadId, requestId: approvalRequestId },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const resolvedIndex = fixture.collector.messages.indexOf(resolved);
    const terminalIndex = fixture.collector.messages.indexOf(completed);
    expect(resolvedIndex).toBeGreaterThan(responseIndex);
    expect(terminalIndex).toBeGreaterThan(resolvedIndex);

    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, {
      id: -1_500_000,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(
      JSON.stringify({ id: 999, result: { official: true } }),
    );
    expect(forwarded.join("")).not.toContain(String(approvalRequestId));
    expect(forwarded.join("")).not.toContain("-1500000");
    expect(session.interactionResponses).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("round-trips an early standalone Question through the Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.askQuestionOnNextTurn(
      {
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [
          { value: "continue-value", label: "Continue" },
          { value: "stop-value", label: "Stop" },
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      },
      { title: "Decision" },
    );

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    expect(request).toMatchObject({
      id: -1,
      params: {
        threadId,
        turnId,
        itemId: expect.any(String),
        questions: [
          {
            id: "decision",
            header: "Decision",
            question: "Choose",
            options: [
              { label: "Continue", description: "" },
              { label: "Stop", description: "" },
            ],
          },
        ],
      },
    });
    const turnResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 2),
    );
    const questionIndex = fixture.collector.messages.indexOf(request);
    expect(questionIndex).toBeGreaterThan(turnResponseIndex);
    const requestIdValue = request.id;
    if (typeof requestIdValue !== "number") throw new Error("Question request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: requestIdValue,
      result: { answers: { decision: { answers: ["Continue"] } } },
    });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id ===
          (request.params as JsonObject).itemId,
    );
    expect(session.interactionResponses).toMatchObject([
      {
        response: { type: "question", answers: { decision: ["continue-value"] } },
      },
    ]);

    session.appendText("continued");
    const turnCompleted = fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", turnId),
    );
    session.succeedTurn();
    await turnCompleted;
    await stopFixture(fixture);
  });

  it("fails a secret Question closed without rendering visible Desktop input", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "secret",
      type: "text",
      prompt: "Secret value",
      multiline: false,
      secret: true,
      optional: false,
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
    });
    expect(
      fixture.collector.messages.filter((message) => method(message, "item/tool/requestUserInput")),
    ).toHaveLength(0);
    const turnCompleted = fixture.collector.waitFor((message) => method(message, "turn/completed"));
    session.succeedTurn();
    await turnCompleted;
    await stopFixture(fixture);
  });

  it("cancels malformed and dismissed Desktop Question responses", async () => {
    for (const result of [
      { answers: { decision: { answers: ["undeclared"] } } },
      { answers: {} },
    ]) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [{ value: "known", label: "Known" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
      writeRequest(fixture.desktopInput, { id: request.id, result });
      await fixture.collector.waitFor((message) => method(message, "item/completed"));
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("cancels a Question at the Host expiry bound", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion(
      {
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      },
      { expiresAt: new Date(Date.now() + 20).toISOString() },
    );
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));
    expect(session.interactionResponses.at(-1)).toMatchObject({
      response: { type: "question", answers: {}, cancelled: true },
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("forwards non-Host responses and consumes retired Host Question responses", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    const interactionId = session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
    session.expireQuestion(interactionId);
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));

    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(
      JSON.stringify({ id: 999, result: { official: true } }),
    );
    expect(forwarded.join("")).not.toContain(String(request.id));

    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("cancels pending steering before draining operations after a Desktop input error", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const oldTurnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      const execute = vi.spyOn(session, "execute");
      writeRequest(fixture.desktopInput, {
        id: 100,
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: oldTurnId,
          input: [{ type: "text", text: "must not start during shutdown" }],
        },
      });
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: oldTurnId }),
      );
      // No terminal event: only shutdown, not the 20-second steering timeout, can release this waiter.
      fixture.desktopInput.destroy(new Error("Synthetic Desktop input failure"));
      const response = await fixture.collector.waitFor((message) => requestId(message, 100));
      expect(response).toMatchObject({ error: { code: -32074 } });
      expect(JSON.stringify(response)).toContain("connection closed before replacement");
      expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));
      expect(await fixture.running).toBe(1);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("steers an external Thread by cancelling, waiting for terminal projection, and starting once", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const oldTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const params = {
      threadId,
      expectedTurnId: oldTurnId,
      clientUserMessageId: "steer-message",
      input: [{ type: "text", text: "new direction" }],
    };
    writeRequest(fixture.desktopInput, { id: 100, method: "turn/steer", params });
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: oldTurnId }),
    );
    expect(fixture.collector.messages.some((message) => requestId(message, 100))).toBe(false);
    writeRequest(fixture.desktopInput, { id: 101, method: "turn/steer", params });
    writeRequest(fixture.desktopInput, {
      id: 102,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "competing" }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 102)),
    ).resolves.toMatchObject({ error: { code: -32072 } });
    session.completeCancellation();
    const response = await fixture.collector.waitFor((message) => requestId(message, 100));
    const replacementId = (response.result as JsonObject).turnId;
    expect(typeof replacementId).toBe("string");
    expect(replacementId).not.toBe(oldTurnId);
    expect(response).toMatchObject({ result: { turnId: replacementId, delivery: "newTurn" } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 101)),
    ).resolves.toMatchObject({
      result: { turnId: replacementId, delivery: "newTurn" },
    });
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/started", String(replacementId)),
    );
    const index = (predicate: (message: JsonObject) => boolean) =>
      fixture.collector.messages.findIndex(predicate);
    expect(index((message) => turnEvent(message, "turn/completed", oldTurnId))).toBeLessThan(
      index((message) => requestId(message, 100)),
    );
    expect(index((message) => requestId(message, 100))).toBeLessThan(
      index((message) => turnEvent(message, "turn/started", String(replacementId))),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: "turn.start",
      turnId: replacementId,
      input: [{ type: "text", text: "new direction" }],
    });
    expect(officialWrite).not.toHaveBeenCalled();
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", String(replacementId)),
    );
    await stopFixture(fixture);
  });

  it("handles synchronous external cancellation and rejects stale or unsupported steer input locally", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const oldTurnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const execute = vi.spyOn(session, "execute");
    for (const [id, params] of [
      [100, { threadId, expectedTurnId: "stale", input: [{ type: "text", text: "new" }] }],
      [
        101,
        {
          threadId,
          expectedTurnId: oldTurnId,
          input: [
            { type: "text", text: "new" },
            { type: "image", url: "image" },
          ],
        },
      ],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "turn/steer",
        params: JSON.parse(JSON.stringify(params)),
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toHaveProperty("error");
    }
    expect(execute).not.toHaveBeenCalled();
    session.completeCancellationOnRequest();
    writeRequest(fixture.desktopInput, {
      id: 102,
      method: "turn/steer",
      params: { threadId, expectedTurnId: oldTurnId, input: [{ type: "text", text: "new" }] },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 102));
    expect(response).toMatchObject({ result: { turnId: expect.any(String), delivery: "newTurn" } });
    session.succeedTurn();
    await stopFixture(fixture);
  });

  it("passes an Account-bound official steer and its result through unchanged", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const params = {
      threadId: "official-thread",
      expectedTurnId: "official-turn",
      clientUserMessageId: "message",
      input: [{ type: "text", text: "new direction" }],
    };
    writeRequest(fixture.desktopInput, { id: 100, method: "turn/steer", params });
    await expect(readJsonLine(fixture.official.stdin)).resolves.toEqual({
      id: 100,
      method: "turn/steer",
      params,
    });
    writeRequest(fixture.official.stdout, { id: 100, result: { turnId: "official-turn" } });
    await expect(fixture.collector.waitFor((message) => requestId(message, 100))).resolves.toEqual({
      id: 100,
      result: { turnId: "official-turn" },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("writes the interrupt response before cancellation lifecycle notifications", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.startCommandExecution("sleep 10");
    session.askQuestion({
      id: "cancel-decision",
      type: "choice",
      prompt: "Continue?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({ params: { turn: { status: "interrupted" } } });

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const questionItemId = (questionRequest.params as JsonObject).itemId;
    const questionClosedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === questionItemId,
    );
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(questionClosedIndex).toBeGreaterThan(responseIndex);
    expect(turnIndex).toBeGreaterThan(questionClosedIndex);
    await stopFixture(fixture);
  });

  it("rejects an interrupt that does not reference the active Pi Turn", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/interrupt",
      params: { threadId, turnId: "missing-turn" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32074, message: "External turn/interrupt must reference the active Turn" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("isolates Pi and Claude Threads behind the same registered Harness path", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      10,
    );
    const piThreadId = await startExternalThread(fixture, "codexhost/pi-native", 11);
    expect(claudeThreadId).not.toBe(piThreadId);
    expect(claudeAdapter.sessions).toHaveLength(1);
    expect(piAdapter.sessions).toHaveLength(1);

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "turn/start",
      params: { threadId: claudeThreadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 12));
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.appendText("claude output");
    const claudeStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(claudeStarted).toBeDefined();
    claudeSession.succeedTurn();
    await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/completed") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );

    expect(piAdapter.sessions[0]?.initialState.effectiveModel).toEqual(
      piAdapter.catalog.defaultModel,
    );
    expect(claudeAdapter.sessions).toHaveLength(1);
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 12));
    const startedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "turn/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(startedIndex).toBeGreaterThan(responseIndex);
    await stopFixture(fixture);
  });

  it("keeps selected Claude Models request-scoped and projects confirmed actual state", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const firstModel = claudeAdapter.catalog.models[0]?.ref;
    const secondModel = claudeAdapter.catalog.models[1]?.ref;
    if (!firstModel || !secondModel) throw new Error("Fake Claude catalog is incomplete");

    const firstThreadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(secondModel),
      20,
    );
    const secondThreadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(firstModel),
      21,
    );
    expect(claudeAdapter.sessions[0]?.initialState.effectiveModel).toEqual(secondModel);
    expect(claudeAdapter.sessions[1]?.initialState.effectiveModel).toEqual(firstModel);

    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "codexhost/thread/model/select",
      params: { threadId: firstThreadId, model: firstModel },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 22)),
    ).resolves.toMatchObject({
      result: {
        effectiveModel: firstModel,
        resolvedModelLabel: "fake-runtime-primary",
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 23,
      method: "codexhost/thread/inspect",
      params: { threadId: firstThreadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 23)),
    ).resolves.toMatchObject({
      result: {
        harnessId: "claude-code",
        transportModelId: encodeClaudeTransportModel(secondModel),
        effectiveModel: firstModel,
        resolvedModelLabel: "fake-runtime-primary",
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "turn/start",
      params: {
        threadId: secondThreadId,
        model: encodePiTransportModel(piAdapter.catalog.defaultModel),
        input: [{ type: "text", text: "foreign" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 24)),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Turn Model carrier does not belong to the Thread Harness",
      },
    });
    expect(claudeAdapter.sessions[1]?.state.effectiveModel).toEqual(firstModel);
    await stopFixture(fixture);
  });

  it("rejects Model selection when the owning Claude Session does not support it", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, 20);
    const model = piAdapter.catalog.defaultModel;
    if (!model) throw new Error("Fake Pi catalog has no default Model");
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.capabilities.configuration.selectModel = false;

    writeRequest(fixture.desktopInput, {
      id: 21,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 21)),
    ).resolves.toMatchObject({
      error: {
        code: -32078,
        message: "External Harness does not support Model selection",
      },
    });
    expect(claudeSession.state.effectiveModel).toEqual(claudeAdapter.catalog.defaultModel);

    const off = claudeAdapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake Claude catalog has no Thinking option");
    claudeSession.capabilities.configuration.selectThinkingOption = false;
    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 22)),
    ).resolves.toMatchObject({
      error: {
        code: -32078,
        message: "External Harness does not support Thinking selection",
      },
    });
    await stopFixture(fixture);
  });

  it("fails closed when a valid Claude token has no registered Adapter", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "thread/start",
      params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({
      error: { code: -32070, message: "External Harness 'claude-code' is unavailable" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("passes only the delegation Runtime whitelist from codexhost internal controls", async () => {
    const fixture = createFixture({
      environment: {
        VISIBLE_TO_OFFICIAL: "yes",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "runtime-token",
        CODEXHOST_CLI_PATH: "/opt/codexhost/bin/codexhost",
        CODEXHOST_DATA_DIR: "/synthetic/codexhost-data",
        CODEXHOST_CLAUDE_COMMAND: "/synthetic/claude",
      },
    });

    await vi.waitFor(() => {
      expect(fixture.spawnOfficial).toHaveBeenCalledWith(
        "/synthetic/codex",
        ["app-server"],
        expect.objectContaining({
          env: expect.objectContaining({
            VISIBLE_TO_OFFICIAL: "yes",
            CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
            CODEXHOST_RUNTIME_TOKEN: "runtime-token",
            CODEXHOST_CLI_PATH: "/opt/codexhost/bin/codexhost",
          }),
        }),
      );
    });
    await stopFixture(fixture);
  });

  it("does not pass internal Harness controls to the official app-server", async () => {
    const fixture = createFixture({
      environment: {
        VISIBLE_TO_OFFICIAL: "yes",
        CODEXHOST_DATA_DIR: "/synthetic/codexhost-data",
        CODEXHOST_ENABLE_CLAUDE_CODE: "1",
        CODEXHOST_CLAUDE_COMMAND: "/synthetic/claude",
        CODEXHOST_PI_COMMAND: "/synthetic/pi",
      },
    });

    await vi.waitFor(() => {
      expect(fixture.spawnOfficial).toHaveBeenCalledWith(
        "/synthetic/codex",
        ["app-server"],
        expect.objectContaining({
          env: expect.objectContaining({ VISIBLE_TO_OFFICIAL: "yes" }),
        }),
      );
    });
    await stopFixture(fixture);
  });

  it("forwards a Codex-owned interrupt without invoking Pi", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });

    writeRequest(fixture.desktopInput, {
      id: 8,
      method: "turn/interrupt",
      params: { threadId: "official-thread", turnId: "official-turn" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: {},
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned history pagination without opening a Pi Session", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const request = {
      id: 8,
      method: "thread/turns/list",
      params: {
        threadId: "official-thread",
        cursor: "official-cursor",
        limit: 7,
        sortDirection: "desc",
        itemsView: "summary",
        extraOfficialField: { keep: true },
      },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(`${JSON.stringify({ id: 8, result: { data: [] } })}\n`);
      });
    });

    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: { data: [] },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards official Codex Usage notifications without external projection", async () => {
    const fixture = createFixture();
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "official-thread",
        turnId: "official-turn",
        tokenUsage: {
          total: {
            totalTokens: 11,
            inputTokens: 5,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 4,
            inputTokens: 4,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 100,
        },
      },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);

    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned requests without opening a Pi Session", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(
        `${JSON.stringify({ id: request.id, result: { source: "official" } })}\n`,
      );
    });

    writeRequest(fixture.desktopInput, {
      id: 9,
      method: "thread/read",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 9))).resolves.toEqual({
      id: 9,
      result: { source: "official" },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });
});
