import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { displayCommand, itemOutcome, reasoningText, toHostItem, userText } from "../src/items.ts";
import { snapshotTurn } from "../src/session.ts";

describe("Codex item mapping", () => {
  it("unwraps the login shell Codex runs commands in", () => {
    assert.equal(displayCommand("/bin/zsh -lc ls"), "ls");
    assert.equal(displayCommand("/bin/zsh -lc 'echo hi > a.txt'"), "echo hi > a.txt");
    assert.equal(displayCommand("bash -c 'it'\\''s'"), "it's");
    assert.equal(displayCommand("npm test"), "npm test");
  });

  it("maps command executions with output, exit code, and failure outcome", () => {
    const raw = {
      type: "commandExecution",
      id: "c1",
      command: '/bin/zsh -lc "false"',
      cwd: "/w",
      aggregatedOutput: "boom",
      exitCode: 1,
      durationMs: 12,
      status: "failed",
    };
    assert.deepEqual(toHostItem(raw), {
      type: "commandExecution",
      itemId: "c1",
      command: "false",
      cwd: "/w",
      output: "boom",
      exitCode: 1,
      durationMs: 12,
    });
    assert.equal(itemOutcome(raw).status, "failed");
  });

  it("maps file changes to unified diffs", () => {
    const raw = {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [
        { path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@\n-a\n+b" },
        { path: "n.ts", kind: { type: "add" }, diff: "+x" },
      ],
    };
    assert.deepEqual(toHostItem(raw), {
      type: "fileChange",
      itemId: "f1",
      changes: [
        { path: "a.ts", kind: "update", unifiedDiff: "@@\n-a\n+b" },
        { path: "n.ts", kind: "add", unifiedDiff: "+x" },
      ],
    });
  });

  it("prefers reasoning summaries over raw reasoning", () => {
    assert.equal(
      reasoningText({ type: "reasoning", id: "r", summary: ["one", "two"], content: ["raw"] }),
      "one\n\ntwo",
    );
    assert.equal(
      reasoningText({ type: "reasoning", id: "r", summary: [], content: ["raw"] }),
      "raw",
    );
  });

  it("maps MCP calls, web search, and skips user messages", () => {
    const mcp = toHostItem({
      type: "mcpToolCall",
      id: "m",
      server: "gh",
      tool: "search",
      arguments: { q: 1 },
      result: { content: [{ type: "text", text: "ok" }] },
      error: null,
      status: "completed",
    });
    assert.deepEqual(mcp, {
      type: "toolExecution",
      itemId: "m",
      toolName: "search",
      namespace: "gh",
      arguments: { q: 1 },
      output: { content: [{ type: "text", text: "ok" }] },
    });
    assert.equal(
      (toHostItem({ type: "webSearch", id: "w", query: "codex" }) as { toolName: string }).toolName,
      "web_search",
    );
    assert.equal(toHostItem({ type: "userMessage", id: "u", content: [] }), undefined);
  });

  it("reads user text including mentions", () => {
    assert.equal(
      userText({
        type: "userMessage",
        id: "u",
        content: [
          { type: "text", text: "look at" },
          { type: "mention", name: "a.ts", path: "/a.ts" },
        ],
      }),
      "look at\n@a.ts",
    );
  });

  it("converts one historical turn with second-resolution timestamps", () => {
    const turn = snapshotTurn("thread-1", {
      id: "turn-1",
      status: "interrupted",
      error: null,
      startedAt: 100,
      completedAt: 131,
      items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text: "go" }] },
        { type: "agentMessage", id: "a", text: "working", phase: "commentary" },
        { type: "plan", id: "p", text: "skipped" },
      ],
    }) as {
      input: unknown;
      items: Array<{ item: { type: string } }>;
      outcome: unknown;
      startedAtMs: number;
      completedAtMs: number;
    };
    assert.deepEqual(turn.input, [{ type: "text", text: "go" }]);
    assert.deepEqual(
      turn.items.map((entry) => entry.item.type),
      ["agentMessage"],
    );
    assert.deepEqual(turn.outcome, { status: "cancelled" });
    assert.equal(turn.startedAtMs, 100_000);
    assert.equal(turn.completedAtMs, 131_000);
  });
});
