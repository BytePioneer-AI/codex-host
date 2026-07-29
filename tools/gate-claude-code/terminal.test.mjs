import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyClaudeResult, summarizeNativeMessages } from "./terminal.mjs";

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../tests/fixtures/gate-claude-code/hermetic.fixture.json",
    ),
    "utf8",
  ),
);

describe("Claude native terminal classification", () => {
  it("accepts only a non-error completed success", () => {
    expect(classifyClaudeResult(fixture.results[0])).toEqual({
      outcome: "succeeded",
      reason: "completed",
    });
  });

  it("does not trust subtype success when native error fields disagree", () => {
    expect(classifyClaudeResult(fixture.results[1])).toEqual({
      outcome: "failed",
      reason: "api_error",
    });
  });

  it("maps an accepted interrupt only after an aborted native result", () => {
    expect(classifyClaudeResult(fixture.results[2], { cancelRequested: true })).toEqual({
      outcome: "cancelled",
      reason: "aborted_tools",
    });
    expect(classifyClaudeResult(fixture.results[2])).toEqual({
      outcome: "failed",
      reason: "unrequested_aborted_tools",
    });
  });

  it("keeps unknown message types without losing known terminal correlation", () => {
    const summary = summarizeNativeMessages([fixture.unknownMessage, fixture.results[0]]);
    expect(summary.unknownTypeCounts).toEqual({ future_control_event: 1 });
    expect(summary.resultCount).toBe(1);
    expect(summary.terminal.outcome).toBe("succeeded");
  });

  it("fails a nominal success when an Assistant error was observed", () => {
    const summary = summarizeNativeMessages([
      { type: "assistant", error: "authentication_failed" },
      fixture.results[0],
    ]);
    expect(summary.assistantErrorKinds).toEqual(["authentication_failed"]);
    expect(summary.terminal).toEqual({ outcome: "failed", reason: "assistant_error" });
  });
});
