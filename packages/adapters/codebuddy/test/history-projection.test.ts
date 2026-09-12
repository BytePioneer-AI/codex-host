import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CODEBUDDY_ID } from "../src/common.js";
import { configuration, modelRef, nativeModel } from "../src/configuration.js";
import { historyUsage, snapshotFromHistory } from "../src/history.js";
import { CodeBuddyTurnOutput } from "../src/projection.js";
import { configOptions } from "./fixtures.js";

const ref = { harnessId: CODEBUDDY_ID, nativeSessionId: "session", formatVersion: 1 as const };
const user = {
  type: "message",
  role: "user",
  id: "user",
  content: [{ type: "input_text", text: "hi" }],
};
const assistant = {
  type: "message",
  role: "assistant",
  id: "answer",
  parentId: "user",
  status: "completed",
  content: [{ type: "output_text", text: "ok" }],
};
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("CodeBuddy native history and output projection", () => {
  it("retains every valid diff in one terminal tool result without duplicate items", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(
      hostTurnIdSchema.parse("multi-diff"),
      process.cwd(),
      (event) => events.push(event),
    );
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "multi",
      status: "completed",
      content: [
        { type: "diff", path: "a.txt", oldText: null, newText: "new A" },
        { type: "diff", path: "b.txt", oldText: "old B", newText: "new B" },
        { type: "diff", path: "invalid", oldText: "old" },
      ],
    };
    output.update(update);
    output.update(update);
    output.finish("succeeded");
    const changes = events.flatMap((e) =>
      e.type === "item.completed" && e.snapshot.item.type === "fileChange" ? [e.snapshot.item] : [],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changes.map((c) => [c.path, c.kind])).toEqual([
      ["a.txt", "add"],
      ["b.txt", "update"],
    ]);
  });
  it("encodes native model IDs opaquely and derives configuration from the native catalog", () => {
    expect(nativeModel(modelRef("provider/model:variant"))).toBe("provider/model:variant");
    expect(configuration(configOptions()).catalog.defaultModel).toEqual(modelRef("native/model"));
    expect(() => configuration([])).toThrow();
  });
  it("follows the current branch, preserves stable IDs, and refuses damaged history", () => {
    const old = { ...assistant, id: "discarded", content: [{ type: "output_text", text: "old" }] };
    const snapshot = snapshotFromHistory(lines([user, old, assistant]), ref, process.cwd());
    expect(snapshot.turns[0]?.items).toMatchObject([{ item: { text: "ok" } }]);
    expect(snapshot.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("user");
    expect(() =>
      snapshotFromHistory(lines([user, { ...assistant, parentId: "missing" }]), ref, process.cwd()),
    ).toThrow("parent is missing");
    expect(() => snapshotFromHistory('{"incomplete":', ref, process.cwd())).toThrow(
      "invalid record",
    );
    expect(snapshotFromHistory(lines([user]), ref, process.cwd()).turns[0]?.outcome.status).toBe(
      "unknown",
    );
  });
  it("deduplicates model-request Usage and reports credits rather than USD", () => {
    const data = {
      messageId: "model-request",
      rawUsage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, credit: 0.12 },
    };
    const tool = { type: "function_call", id: "tool", parentId: "user", providerData: data };
    const history = lines([user, tool, { ...assistant, parentId: "tool", providerData: data }]);
    expect(historyUsage(history)).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      totalCredits: 0.12,
    });
  });
  it("does not expose partial arguments as output, deduplicates tool_call, and retains a failed tool", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(hostTurnIdSchema.parse("turn"), process.cwd(), (event) =>
      events.push(event),
    );
    output.update({
      sessionUpdate: "tool_call",
      toolCallId: "call",
      title: "PowerShell",
      status: "in_progress",
      rawInput: {},
    });
    output.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      rawInput: { command: "wr" },
      content: [{ type: "content", content: { type: "text", text: "wr" } }],
    });
    expect(events).toEqual([]);
    output.update({
      sessionUpdate: "tool_call",
      toolCallId: "call",
      rawInput: { command: "write-output fixture" },
      _meta: { "codebuddy.ai/toolName": "PowerShell", "codebuddy.ai/toolArgumentsComplete": true },
    });
    output.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      status: "failed",
      rawOutput: { type: "text", text: "execution failed" },
    });
    output.update({ sessionUpdate: "tool_call_update", toolCallId: "call", status: "failed" });
    output.finish("succeeded");
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.completed")).toMatchObject([
      {
        snapshot: {
          item: { command: "write-output fixture", output: "execution failed" },
          outcome: { status: "failed" },
        },
      },
    ]);
  });
  it("emits immutable text starts and never mixes Team member text into the parent", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(hostTurnIdSchema.parse("turn"), "/work", (event) =>
      events.push(event),
    );
    output.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "message",
      content: { type: "text", text: "parent" },
    });
    output.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "child" },
      _meta: { "codebuddy.ai/memberEvent": "worker" },
    });
    output.finish("succeeded");
    expect(events[0]).toMatchObject({ item: { text: "" } });
    expect(events.at(-1)).toMatchObject({ snapshot: { item: { text: "parent" } } });
  });
});
