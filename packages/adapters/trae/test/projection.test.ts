import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { catalogFrom, decodeModel, modelRef, stateFrom } from "../src/configuration.js";
import { historyFrom, projectItem, TurnProjection, usageFrom } from "../src/projection.js";

describe("Trae native projection", () => {
  it("keeps Provider identity opaque and rejects foreign or noncanonical Model Refs", () => {
    const ref = modelRef("model with/slashes", "provider / local");
    expect(decodeModel(ref)).toEqual({
      model: "model with/slashes",
      modelProvider: "provider / local",
    });
    expect(() => decodeModel({ id: "foreign" } as typeof ref)).toThrow("does not belong");
    expect(() => decodeModel({ id: "trae-model-v1.invalid" } as typeof ref)).toThrow("Malformed");
    expect(modelRef("x", "one")).not.toEqual(modelRef("x", "two"));
  });
  it("uses native acknowledgment and handles a catalog that omits default Provider identity", () => {
    const catalog = catalogFrom([
      { model: "native", displayName: "Native", supportedReasoningEfforts: [] },
    ]);
    const response = {
      thread: { id: "session" },
      cwd: process.cwd(),
      model: "native",
      modelProvider: "actual",
      reasoningEffort: "high",
      sandbox: { type: "readOnly" },
      approvalPolicy: "on-request",
    };
    expect(stateFrom(response, process.cwd(), catalog)).toMatchObject({
      effectiveModel: modelRef("native"),
      availableThinkingOptions: [],
      effectivePermissionModeId: "read-only",
    });
    expect(stateFrom(response, process.cwd(), catalog)).not.toHaveProperty(
      "effectiveThinkingOptionId",
    );
    expect(() =>
      stateFrom({ ...response, cwd: process.cwd() + "/other" }, process.cwd(), catalog),
    ).toThrow("workspace");
  });
  it("projects native command results, file patches, tools and compaction without raw reasoning", () => {
    expect(
      projectItem({ id: "r", type: "reasoning", summary: ["public"], content: ["private chain"] }),
    ).toMatchObject({ type: "reasoning", text: "public" });
    expect(
      projectItem({
        id: "c",
        type: "commandExecution",
        command: "echo ok",
        cwd: "/work",
        aggregatedOutput: "ok",
        exitCode: 0,
        durationMs: 5,
      }),
    ).toMatchObject({ type: "commandExecution", command: "echo ok", output: "ok", exitCode: 0 });
    const change = { path: "/work/a", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" };
    expect(projectItem({ id: "f", type: "fileChange", changes: [change] })).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/work/a", kind: "update", unifiedDiff: change.diff }],
    });
    expect(
      projectItem({
        id: "m",
        type: "mcpToolCall",
        server: "files",
        tool: "read",
        arguments: { path: "a" },
        result: { content: "actual" },
      }),
    ).toMatchObject({
      type: "toolExecution",
      namespace: "files",
      toolName: "read",
      arguments: { path: "a" },
      output: { content: [{ type: "text", text: JSON.stringify({ content: "actual" }) }] },
    });
    expect(projectItem({ id: "compaction", type: "contextCompaction" })).toMatchObject({
      type: "contextCompaction",
    });
    expect(() =>
      projectItem({ id: "bg", type: "commandExecution", command: "long", status: "backgrounded" }),
    ).toThrow("Detached Trae commands");
  });
  it("uses authoritative final Items, ends incomplete Items once on failure and ignores late deltas", () => {
    const events: HostEvent[] = [];
    const p = new TurnProjection(hostTurnIdSchema.parse("t1"), (e) => events.push(e));
    p.item({ id: "a", type: "agentMessage", text: "" }, false);
    p.delta("item/agentMessage/delta", { itemId: "a", delta: "preview" });
    p.item({ id: "a", type: "agentMessage", text: "authoritative" }, true);
    p.item({ id: "a", type: "agentMessage", text: "duplicate" }, true);
    p.item({ id: "c", type: "commandExecution", command: "long" }, false);
    p.finish({
      status: "failed",
      error: { code: "processExited", message: "gone", retryable: false },
    });
    const count = events.length;
    p.delta("item/agentMessage/delta", { itemId: "a", delta: "late" });
    p.finish({ status: "succeeded" });
    expect(events).toHaveLength(count);
    expect(events.filter((e) => e.type === "item.completed")).toEqual([
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({ text: "authoritative" }),
          outcome: { status: "succeeded" },
        },
      }),
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({ command: "long" }),
          outcome: expect.objectContaining({ status: "failed" }),
        },
      }),
    ]);
  });
  it("refuses partial or mismatched history and does not invent token costs", () => {
    expect(() => historyFrom({ thread: { id: "wrong", turns: [] } }, "session")).toThrow(
      "identity",
    );
    expect(() =>
      historyFrom(
        { thread: { id: "session", turns: [{ id: "turn", itemsView: "summary", items: [] }] } },
        "session",
      ),
    ).toThrow("incomplete");
    expect(usageFrom({ total: { inputTokens: -1, outputTokens: "3" } })).toBeNull();
    expect(usageFrom({ total: { totalTokens: 12 } })).toEqual({ totalTokens: 12 });
    expect(usageFrom({ total: { totalTokens: 12 }, modelContextWindow: 1000 })).toEqual({
      totalTokens: 12,
    });
  });
});
