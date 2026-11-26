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

it("restores tool cards and the final answer in converted Codex history", () => {
  const call =
    "[external_agent_tool_call: Bash]\ndescription: Show help\ncommand: example --help\n[/external_agent_tool_call]";
  const result = "[external_agent_tool_result]\nUsage: example\n[/external_agent_tool_result]";
  const emptyResult = "[external_agent_tool_result]\n[/external_agent_tool_result]";
  const answer = "The task finished.";
  const prompt = "@Hermes 让它回复 1";
  const instruction =
    "[codexhost delegation] The user mentioned @Hermes (Harness `hermes`). Use the codexhost-delegation skill to delegate this request to that Harness with `delegate start --harness <id>` through the executable in CODEXHOST_CLI_PATH, instead of doing the task yourself.";
  const historical = thread();
  historical.modelProvider = "openai";
  historical.historyMode = "paginated";
  const imported = {
    id: "external-import-turn-2",
    status: "completed",
    items: [
      {
        id: "item-3",
        type: "userMessage",
        content: [{ type: "text", text: `${prompt}\n\n${instruction}` }],
      },
      { id: "item-4", type: "agentMessage", text: call, phase: null },
      { id: "item-5", type: "agentMessage", text: result, phase: null },
      { id: "item-6", type: "agentMessage", text: call, phase: null },
      { id: "item-7", type: "agentMessage", text: emptyResult, phase: null },
      { id: "item-8", type: "agentMessage", text: answer, phase: null },
      { id: "item-9", type: "agentMessage", text: "<EXTERNAL SESSION IMPORTED>", phase: null },
    ],
  };
  historical.turns = [imported];
  const view = new ChThreadView({ ...historical, turns: [] }, "codex", () => {});
  view.update(structuredClone(historical));
  const events = view.log.events;
  const data = (type: string) =>
    events.filter((event) => event.type === type).map((event) => event.data);
  assert.match(JSON.stringify(data("user/message")), /@Hermes 让它回复 1/u);
  assert.doesNotMatch(JSON.stringify(data("user/message")), /codexhost delegation/u);
  assert.match(JSON.stringify(data("tool/call")), /example --help/u);
  assert.match(JSON.stringify(data("tool/result")), /Usage: example/u);
  assert.equal(data("tool/result").length, 2);
  const messages = (
    data("assistant/message") as { step: number; message: { content: { type: string }[] } }[]
  ).filter(({ message }) => message.content.some((part) => part.type === "text"));
  assert.equal(messages.length, 1);
  assert.match(JSON.stringify(messages), /The task finished\./u);
  const message = messages[0]!;
  assert.equal(typeof message.step, "number");
  assert.equal(
    (data("turn/end")[0] as { finalAssistantStep: number }).finalAssistantStep,
    message.step,
  );
  assert.deepEqual(view.thread.turns, [imported]);
  assert.match(JSON.stringify(view.editableMessage()?.input), /codexhost delegation/u);

  const count = events.length;
  view.update(structuredClone(historical));
  assert.equal(events.length, count);

  const ordinary = new ChThreadView({ ...historical, turns: [] }, "codex", () => {});
  ordinary.update({ ...historical, turns: [{ ...imported, id: "ordinary-turn" }] });
  assert.ok(
    ordinary.log.events.some(
      (event) =>
        event.type === "assistant/message" &&
        JSON.stringify(event.data).includes("external_agent_tool_call"),
    ),
  );
  assert.ok(
    ordinary.log.events.some(
      (event) =>
        event.type === "user/message" &&
        JSON.stringify(event.data).includes("codexhost delegation"),
    ),
  );
  assert.ok(!ordinary.log.events.some((event) => event.type === "tool/call"));
});

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
