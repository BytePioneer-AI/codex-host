import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HostAgentMessageItem, HostEvent } from "@codexhost/harness-adapter";
import {
  CodexTurnProjector,
  projectHistoricalTurn,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";
import { hostItemIdSchema, hostTurnIdSchema, type JsonObject } from "@codexhost/shared-contracts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorTurnOutput, cursorSnapshot } from "../src/projection.js";

describe("shared relative agent media projection", () => {
  let cwd: string;
  const turnId = hostTurnIdSchema.parse("media-prototype");
  const itemId = hostItemIdSchema.parse("message");
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const notification = (text: string): SessionNotification => ({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
  const destination = (file: string) =>
    path.join(cwd, file).replaceAll("\\", "/").replaceAll("%", "%2525");
  const newProjector = () =>
    new CodexTurnProjector({ threadId: "external", turnId, cwd, startedAtMs: 1 });
  const item = (text: string): HostAgentMessageItem => ({ type: "agentMessage", itemId, text });
  const complete = (projector: CodexTurnProjector, message: HostAgentMessageItem) =>
    projector.project({
      type: "item.completed",
      turnId,
      snapshot: { item: message, outcome: { status: "succeeded" } },
    });

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "host-media%41-"));
    await writeFile(path.join(cwd, "shot.png"), "synthetic image");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("projects real Cursor text.append output and native replay without changing the native ledger", () => {
    const projector = newProjector();
    const wire: JsonObject[] = [];
    const native: HostEvent[] = [];
    wire.push(...projector.project({ type: "turn.started", turnId }).messages);
    const output = new CursorTurnOutput(turnId, (event) => {
      native.push(structuredClone(event));
      wire.push(...projector.project(event as ProjectableHostEvent).messages);
    });
    const first = notification("见 ![shot](<sho");
    const second = notification("t.png>)。");
    const chunks = [first, second];
    output.update(first);
    expect(projector.pendingTurn().items).toMatchObject([
      { type: "agentMessage", text: "见 ![shot](" },
    ]);
    output.update(second);
    output.finish({ status: "succeeded" });
    const replay = cursorSnapshot(
      sessionId,
      [{ id: "native-turn", text: "show" }],
      [
        {
          sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "show" } },
        },
        ...chunks,
      ],
    );
    const snapshot = replay.turns[0];
    if (!snapshot) throw new Error("Expected a native Cursor Turn");
    const terminal = projector.project({
      type: "turn.completed",
      turnId,
      nativeTurnRef: snapshot.nativeTurnRef,
      outcome: { status: "succeeded" },
    });
    wire.push(...terminal.messages);
    const expected = `见 ![shot](<${destination("shot.png")}>)。`;
    expect(
      native
        .filter((e) => e.type === "item.updated")
        .map((e) => (e.update.type === "text.append" ? e.update.text : ""))
        .join(""),
    ).toBe("见 ![shot](<shot.png>)。");
    expect(snapshot.items[0]?.item).toMatchObject({
      type: "agentMessage",
      text: "见 ![shot](<shot.png>)。",
    });
    expect(
      wire
        .filter((e) => e.method === "item/agentMessage/delta")
        .map((e) => (e.params as JsonObject).delta)
        .join(""),
    ).toBe(expected);
    expect(terminal.completedTurn?.items).toMatchObject([
      { type: "agentMessage", text: expected, phase: "final_answer" },
    ]);
    for (const message of wire.filter((e) => e.method === "item/completed")) {
      expect((message.params as JsonObject).item).toMatchObject({
        type: "agentMessage",
        text: expected,
      });
    }
    expect(projectHistoricalTurn({ turnId, cwd, snapshot }).items).toMatchObject([
      { type: "userMessage" },
      { type: "agentMessage", text: expected, phase: "final_answer" },
    ]);
  });

  it("covers full-text starts and caches the display through pending, terminal and phase replay", async () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    const native = item("![shot](shot.png)");
    const started = projector.project({ type: "item.started", turnId, item: native });
    expect((started.messages[0]?.params as JsonObject).item).toMatchObject({
      text: `![shot](${destination("shot.png")})`,
    });
    expect(projector.pendingTurn().items).toMatchObject([
      { text: `![shot](${destination("shot.png")})` },
    ]);
    const completed = complete(projector, native);
    expect((completed.messages[0]?.params as JsonObject).item).toMatchObject({
      text: `![shot](${destination("shot.png")})`,
    });
    await rm(path.join(cwd, "shot.png"));
    expect(projector.pendingTurn().items).toMatchObject([
      { text: `![shot](${destination("shot.png")})` },
    ]);
    const terminal = projector.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(terminal.completedTurn?.items).toMatchObject([
      { text: `![shot](${destination("shot.png")})`, phase: "final_answer" },
    ]);
    expect((terminal.messages[0]?.params as JsonObject).item).toMatchObject({
      text: `![shot](${destination("shot.png")})`,
    });
    expect(native).toEqual(item("![shot](shot.png)"));
  });

  it("flushes unfinished native text before item/completed and final-answer replay", () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    projector.project({ type: "item.started", turnId, item: item("") });
    const raw = "![shot](shot.png) and `unfinished";
    const updates = projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: raw },
    });
    const completed = complete(projector, item(raw));
    expect(completed.messages[0]).toMatchObject({
      method: "item/agentMessage/delta",
      params: { delta: "`unfinished" },
    });
    const expected = `![shot](${destination("shot.png")}) and \`unfinished`;
    expect(
      [...updates.messages, ...completed.messages]
        .filter((m) => m.method === "item/agentMessage/delta")
        .map((m) => (m.params as JsonObject).delta)
        .join(""),
    ).toBe(expected);
    const terminal = projector.project({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect((terminal.messages[0]?.params as JsonObject).item).toMatchObject({
      text: expected,
      phase: "final_answer",
    });
  });

  it("still rejects native completion mismatches and recovers using native failure events", () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    projector.project({ type: "item.started", turnId, item: item("") });
    const raw = "![shot](shot.png) `unfinished";
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: raw },
    });
    expect(() => complete(projector, item("different"))).toThrow(
      "completion does not match its append updates",
    );
    expect(() =>
      complete(projector, item(raw.replace("shot.png", destination("shot.png")))),
    ).toThrow("completion does not match its append updates");
    const error = { code: "protocolError" as const, message: "fixture failed", retryable: false };
    const events = projector.failureEvents(error);
    expect(events[0]).toMatchObject({ type: "item.completed", snapshot: { item: { text: raw } } });
    const wire = events.flatMap((event) => projector.project(event).messages);
    expect(wire).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            text: `![shot](${destination("shot.png")}) \`unfinished`,
          }),
        }),
      }),
    );
  });

  it("uses only Thread cwd, without guessing directories or promoting code and ordinary links", async () => {
    const extra = path.join(cwd, "native-session");
    await mkdir(extra);
    await writeFile(path.join(extra, "shot.png"), "different image outside the chosen cwd");
    await writeFile(path.join(extra, "nested.png"), "not searched recursively");
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    const native = item("![shot](shot.png) ![nested](nested.png) `shot.png` [link](shot.png)");
    projector.project({ type: "item.started", turnId, item: native });
    complete(projector, native);
    expect(projector.pendingTurn().items).toMatchObject([
      {
        text: `![shot](${destination("shot.png")}) ![nested](nested.png) \`shot.png\` [link](shot.png)`,
      },
    ]);
  });

  it("keeps filesystem decisions stable within an Item, not across new Items or reloads", async () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    projector.project({ type: "item.started", turnId, item: item("") });
    const reference = "![later](later.png) ";
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: reference },
    });
    await writeFile(path.join(cwd, "later.png"), "appeared later");
    projector.project({
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: reference },
    });
    complete(projector, item(reference.repeat(2)));
    const next = { ...item(reference), itemId: hostItemIdSchema.parse("next") };
    projector.project({ type: "item.started", turnId, item: next });
    complete(projector, next);
    expect(projector.pendingTurn().items).toMatchObject([
      { text: reference.repeat(2) },
      { text: `![later](${destination("later.png")}) ` },
    ]);
    const native = cursorSnapshot(
      sessionId,
      [{ id: "native-turn", text: "show" }],
      [
        {
          sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "show" } },
        },
        notification(reference.repeat(2)),
      ],
    );
    const snapshot = native.turns[0];
    if (!snapshot) throw new Error("Expected a native Cursor Turn");
    expect(projectHistoricalTurn({ turnId, cwd, snapshot }).items).toContainEqual(
      expect.objectContaining({ text: `![later](${destination("later.png")}) `.repeat(2) }),
    );
  });

  it("does not rewrite reasoning previews or transcripts", () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    const text = "![shot](shot.png)";
    const reasoningId = hostItemIdSchema.parse("reasoning");
    projector.project({
      type: "item.started",
      turnId,
      item: { type: "reasoning", itemId: reasoningId, text: "" },
    });
    const update = projector.project({
      type: "item.updated",
      turnId,
      itemId: reasoningId,
      update: { type: "text.append", text },
    });
    expect(update.messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        params: expect.objectContaining({ delta: text }),
      }),
    );
  });

  it("does not invent a start for an invalid bare item.completed event", () => {
    const projector = newProjector();
    projector.project({ type: "turn.started", turnId });
    expect(() => complete(projector, item("![shot](shot.png)"))).toThrow("unknown Item");
  });
});
