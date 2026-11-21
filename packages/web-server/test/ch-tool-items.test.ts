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

it("groups consecutive native imageView items into one assistant image gallery", () => {
  const view = new ChThreadView(
    thread(),
    "codex",
    () => {},
    0,
    0,
    () => false,
    undefined,
    (path) => ({
      attachmentId: `image:${path}`,
      name: path.split("/").at(-1),
      mediaType: "image/png",
      bytes: 1,
      width: 1,
      height: 1,
    }),
  );
  view.update(
    thread(
      [
        {
          id: "image-1",
          type: "imageView",
          path: "/w/photo with spaces.png",
        },
        {
          id: "image-2",
          type: "imageView",
          path: "/w/second.png",
        },
      ],
      "completed",
    ),
  );

  const messages = view.log.events.filter((entry) => entry.type === "assistant/message");
  assert.equal(
    messages.length,
    1,
    "completed imageViews must not be projected again at Turn close",
  );
  assert.deepEqual((messages[0]?.data as { message: { content: unknown[] } }).message.content, [
    {
      type: "image",
      codexhostImageView: true,
      attachment: {
        attachmentId: "image:/w/photo with spaces.png",
        name: "photo with spaces.png",
        mediaType: "image/png",
        bytes: 1,
        width: 1,
        height: 1,
      },
    },
    {
      type: "image",
      codexhostImageView: true,
      attachment: {
        attachmentId: "image:/w/second.png",
        name: "second.png",
        mediaType: "image/png",
        bytes: 1,
        width: 1,
        height: 1,
      },
    },
  ]);
});

it("reuses one image projection when a live Turn gains an imageView", () => {
  let first = true;
  const view = new ChThreadView(
    thread(),
    "codex",
    () => {},
    0,
    0,
    () => false,
    undefined,
    (path) => {
      const attachmentId = first ? `image:${path}:first` : `image:${path}:second`;
      first = false;
      return {
        attachmentId,
        name: path.split("/").at(-1),
        mediaType: "image/png",
        bytes: 1,
        width: 1,
        height: 1,
      };
    },
  );
  view.update(thread([], "inProgress"));
  view.update(
    thread(
      [
        {
          id: "image-live",
          type: "imageView",
          path: "/w/live.png",
        },
      ],
      "inProgress",
    ),
  );
  view.update(
    thread(
      [
        {
          id: "image-live",
          type: "imageView",
          path: "/w/live.png",
        },
      ],
      "completed",
    ),
  );

  const message = view.log.events.find((entry) => entry.type === "assistant/message");
  assert.ok(message);
  const content = (message.data as { message: { content: unknown[] } }).message.content;
  assert.equal(
    (
      content.find((part) => (part as { type?: string }).type === "image") as {
        attachment: { attachmentId: string };
      }
    ).attachment.attachmentId,
    "image:/w/live.png:first",
  );
});
