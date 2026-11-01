import { describe, expect, it } from "vitest";
import { mapQoderSnapshot } from "../src/qoder-history.js";
import type { SessionMessage } from "../src/qoder-sdk-types.js";

function message(
  type: SessionMessage["type"],
  uuid: string,
  content: unknown,
  stopReason?: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "history-test",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: type, content, ...(stopReason ? { stop_reason: stopReason } : {}) },
  };
}

const user = message("user", "user-1", "Run the command");
const final = message("assistant", "final-1", [{ type: "text", text: "Done" }], "end_turn");
const bash = message(
  "assistant",
  "tool-1",
  [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "node long-task.js" } }],
  "tool_use",
);
const result = message("user", "result-1", [
  { type: "tool_result", tool_use_id: "bash-1", content: "" },
]);

describe("Qoder historical completion evidence", () => {
  it.each([
    ["only user input", [user]],
    ["partial assistant text", [user, message("assistant", "partial", "Working...")]],
    ["token limit", [user, message("assistant", "truncated", "Partial", "max_tokens")]],
    ["tool result without a final answer", [user, bash, result]],
  ] as const)("keeps %s unknown", (_name, messages) => {
    const turn = mapQoderSnapshot(messages, "history-test").turns[0];
    expect(turn?.outcome.status).toBe("unknown");
    expect(
      turn?.items.some(({ item }) => item.type === "agentMessage" && item.phase === "final_answer"),
    ).toBe(false);
  });

  it.each([false, true])(
    "does not invent Bash success when result is missing (final=%s)",
    (hasFinal) => {
      const turn = mapQoderSnapshot([user, bash, ...(hasFinal ? [final] : [])], "history-test")
        .turns[0];
      expect(turn?.outcome.status).toBe("unknown");
      expect(turn?.items[0]).toMatchObject({
        item: { type: "commandExecution", command: "node long-task.js" },
        outcome: { status: "cancelled", reason: "No confirmed Qoder tool result" },
      });
      expect(turn?.items[0]?.item).not.toHaveProperty("exitCode");
      expect(turn?.items[0]?.item).not.toHaveProperty("output");
    },
  );

  it("does not mark a file tool without a result successful", () => {
    const tool = message(
      "assistant",
      "write-1",
      [
        {
          type: "tool_use",
          id: "write-1",
          name: "Write",
          input: { file_path: "a.txt", content: "a" },
        },
      ],
      "tool_use",
    );
    const turn = mapQoderSnapshot([user, tool], "history-test").turns[0];
    expect(turn?.outcome.status).toBe("unknown");
    expect(turn?.items[0]).toMatchObject({
      item: { type: "toolExecution", toolName: "Write" },
      outcome: { status: "cancelled" },
    });
  });

  it("preserves confirmed success, including an empty tool result", () => {
    const turn = mapQoderSnapshot([user, bash, result, final], "history-test").turns[0];
    expect(turn?.outcome.status).toBe("succeeded");
    expect(turn?.items[0]).toMatchObject({
      item: { type: "commandExecution", exitCode: 0 },
      outcome: { status: "succeeded" },
    });
    expect(turn?.items[1]?.item).toMatchObject({ type: "agentMessage", phase: "final_answer" });
  });

  it("preserves a recorded tool failure", () => {
    const failure = message("user", "result-1", [
      { type: "tool_result", tool_use_id: "bash-1", content: "Command failed", is_error: true },
    ]);
    const turn = mapQoderSnapshot([user, bash, failure, final], "history-test").turns[0];
    expect(turn?.items[0]).toMatchObject({
      item: { type: "commandExecution", exitCode: 1 },
      outcome: { status: "failed", error: { message: "Command failed" } },
    });
  });

  it("preserves an explicit native API failure", () => {
    const failure = {
      ...message("assistant", "error-1", "API failed"),
      isApiErrorMessage: true as const,
    };
    expect(mapQoderSnapshot([user, failure], "history-test").turns[0]?.outcome.status).toBe(
      "failed",
    );
  });

  it("does not mark an uncompleted compact command successful", () => {
    const turn = mapQoderSnapshot([message("user", "compact-1", "/compact")], "history-test")
      .turns[0];
    expect(turn?.outcome.status).toBe("unknown");
    expect(turn?.items[0]).toMatchObject({
      item: { type: "contextCompaction" },
      outcome: { status: "cancelled" },
    });
  });
});
