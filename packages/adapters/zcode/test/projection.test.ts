import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { harnessModelRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { decodeModel, encodeModel } from "../src/models.js";
import { fileChanges, TurnProjection } from "../src/projection.js";
import { makeInteraction } from "../src/interactions.js";
import { eventSchema, modelSchema } from "../src/protocol.js";

describe("ZCode native projections", () => {
  it("keeps Provider and Model identities unambiguous", () => {
    for (const model of [
      { providerId: "provider/name", modelId: "模型/1" },
      { providerId: "provider", modelId: "name/模型/1" },
    ])
      expect(decodeModel(encodeModel(model))).toEqual(model);
    expect(encodeModel({ providerId: "a/b", modelId: "c" })).not.toEqual(
      encodeModel({ providerId: "a", modelId: "b/c" }),
    );
    expect(() => decodeModel(harnessModelRefSchema.parse({ id: "raw-model" }))).toThrow(
      "Invalid ZCode model reference",
    );
  });
  it("shortens official Coding Plan labels without changing model identities or custom names", () => {
    for (const [providerId, providerLabel, prefix] of [
      ["account:bigmodel-individual-coding-plan", "BigModel Individual Coding Plan", "BigModel"],
      ["account:zai-individual-coding-plan", "Z.AI Individual Coding Plan", "Z.AI"],
      ["account:bigmodel-start-plan", "Start Plan", "Start Plan"],
      ["custom-provider", "BigModel Individual Coding Plan", "BigModel Individual Coding Plan"],
    ]) {
      for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
        const ref = { providerId, modelId };
        const model = modelSchema.parse({ ref, providerLabel, label: modelId });
        expect(model.ref).toEqual(ref);
        expect(model.label).toBe(`${prefix} / ${modelId}`);
      }
    }
    expect(
      modelSchema.parse({ ref: { providerId: "custom", modelId: "m" }, label: "Model Alias" })
        .label,
    ).toBe("Model Alias");
  });

  it("keeps separate assistant messages and receives tool arguments from the native model stream", () => {
    const events: HostEvent[] = [],
      projection = new TurnProjection(hostTurnIdSchema.parse("turn"), "/workspace", (event) =>
        events.push(event),
      );
    let seq = 0;
    const send = (type: string, payload: unknown) =>
      projection.event(
        eventSchema.parse({
          eventId: String(++seq),
          sessionId: "native",
          seq,
          timestamp: 1,
          type,
          payload,
        }),
      );
    send("model.streaming", { kind: "text_delta", assistantMessageId: "one", delta: "First." });
    send("model.streaming", {
      kind: "tool_call",
      toolCallId: "bash",
      toolName: "Bash",
      input: { command: "pwd" },
    });
    send("tool.updated", {
      kind: "scheduled",
      toolCallId: "bash",
      toolName: "Bash",
      inputOmitted: true,
    });
    send("tool.updated", {
      kind: "result",
      toolCallId: "bash",
      result: { success: true, content: "/workspace" },
    });
    send("model.streaming", { kind: "text_delta", assistantMessageId: "two", delta: "Second." });
    projection.finish({ status: "succeeded" });
    const completed = events
      .filter((event) => event.type === "item.completed")
      .map((event) => event.snapshot.item);
    expect(
      completed.filter((item) => item.type === "agentMessage").map((item) => item.text),
    ).toEqual(["First.", "Second."]);
    expect(completed.find((item) => item.type === "commandExecution")).toMatchObject({
      command: "pwd",
      output: "/workspace",
    });
    expect(
      events.filter((event) => event.type === "item.started" && event.item.itemId === "bash"),
    ).toHaveLength(1);
  });
  it("uses native permission response payloads and rejects mismatched answers", () => {
    const response = {
      decision: "allow",
      permissionUpdates: [{ type: "addRules", destination: "session", rules: [] }],
    };
    const pending = makeInteraction(
      "interaction/requestPermission",
      {
        requestId: "permission",
        toolName: "Bash",
        options: [
          { optionId: "session", name: "This session", kind: "allow_session", response },
          { optionId: "deny", name: "Deny", response: { decision: "deny" } },
        ],
      },
      hostTurnIdSchema.parse("turn"),
    );
    expect(pending.response({ type: "approval", actionId: "session" })).toEqual(response);
    expect(() => pending.response({ type: "approval", actionId: "other" })).toThrow();
    const question = makeInteraction(
      "interaction/requestUserInput",
      {
        requestId: "question",
        questions: [{ question: "Continue?", options: [{ value: "yes", label: "Yes" }] }],
      },
      hostTurnIdSchema.parse("turn"),
    );
    expect(question.response({ type: "question", answers: { "0": ["yes"] } })).toEqual({
      action: "accept",
      content: { answers: { "Continue?": "yes" } },
    });
    expect(question.response({ type: "question", cancelled: true, answers: {} })).toEqual({
      action: "cancel",
    });
  });
  it("only constructs file changes from native content or complete structured hunks", () => {
    expect(fileChanges({ filePath: "a.txt", originalFile: null, content: "new\n" })).toMatchObject([
      { kind: "add", unifiedDiff: expect.stringContaining("+new") },
    ]);
    expect(fileChanges({ filePath: "a.txt", output: "changed a file" })).toEqual([]);
    expect(
      fileChanges({ filePath: "a.txt", structuredPatch: [{ oldStart: 1, newStart: 1 }] }),
    ).toEqual([]);
    expect(
      fileChanges({
        filePath: "a.txt",
        structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-old", "+new"] }],
      }),
    ).toEqual([]);
    expect(
      fileChanges({
        filePath: "a.txt",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
        ],
      }),
    ).toMatchObject([{ kind: "update", unifiedDiff: expect.stringContaining("@@ -1,1 +1,1 @@") }]);
  });
});
