import assert from "node:assert/strict";
import { it } from "node:test";

import { ChThreadView, type ChThread } from "../src/ch-thread-view.ts";

function thread(items?: ChThread["turns"][number]["items"], status = "completed"): ChThread {
  return {
    id: "t1",
    cwd: "/w",
    modelProvider: "claude-code",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: !items
      ? []
      : [
          {
            id: "turn-1",
            status,
            items: [
              { id: "user", type: "userMessage", content: [{ type: "text", text: "go" }] },
              ...items,
            ],
          },
        ],
  };
}

it("shows CH MCP tool calls and web searches as named DSH tool calls", () => {
  const view = new ChThreadView(thread(), "claude-code", () => {});
  view.update(
    thread([
      {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "docs",
        tool: "lookup",
        status: "completed",
        arguments: { id: 7 },
        result: {
          content: [{ type: "text", text: "found" }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
      },
      {
        id: "mcp-2",
        type: "mcpToolCall",
        server: "docs",
        tool: "lookup",
        status: "failed",
        arguments: { id: 8 },
        result: null,
        error: { message: "server unavailable" },
      },
      {
        id: "search-1",
        type: "webSearch",
        query: "codex",
        action: { type: "search", query: "codex", queries: null },
        results: null,
      },
    ]),
  );
  const calls = view.log.events
    .filter((entry) => entry.type === "tool/call")
    .map((entry) => {
      const data = entry.data as { name: string; arguments: string };
      return { name: data.name, arguments: JSON.parse(data.arguments) as unknown };
    });
  assert.deepEqual(calls, [
    { name: "docs__lookup", arguments: { id: 7 } },
    { name: "docs__lookup", arguments: { id: 8 } },
    { name: "web_search", arguments: { query: "codex", queries: ["codex"] } },
  ]);
  const results = view.log.events
    .filter((entry) => entry.type === "tool/result")
    .map((entry) => {
      const message = (entry.data as { message: { content: unknown; isError: boolean } }).message;
      return { content: JSON.stringify(message.content), isError: message.isError };
    });
  assert.equal(results.length, 3);
  assert.match(results[0]?.content ?? "", /found/);
  assert.equal(results[0]?.isError, false);
  assert.match(results[1]?.content ?? "", /server unavailable/);
  assert.equal(results[1]?.isError, true);
  assert.equal(results[2]?.isError, false);
});

it("completes a live CH web search row while its Turn is still running", () => {
  const view = new ChThreadView(thread(), "claude-code", () => {});
  view.update(
    thread(
      [
        {
          id: "search-1",
          type: "webSearch",
          query: "codex",
          action: { type: "search", query: "codex", queries: null },
          results: null,
        },
      ],
      "inProgress",
    ),
  );
  const results = view.log.events.filter((entry) => entry.type === "tool/result");
  assert.equal(results.length, 1);
  assert.equal((results[0]?.data as { message: { isError: boolean } }).message.isError, false);
});
