import { expect, it, vi } from "vitest";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { NativeClientChannel } from "../src/native-client-channel.js";

function fixture(meta: JsonObject = {}, overrides: JsonObject = {}) {
  const respond = vi.fn(async () => undefined);
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request: vi.fn(async () => ({ result: {} })),
    respond,
    desktopConnected: () => true,
  });
  channel.observeMessage({
    id: "native-safari-approval",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "native-thread",
      mode: "form",
      serverName: "cua_repl",
      message: 'Allow Computer Use to use "Safari"?',
      requestedSchema: { type: "object", properties: {} },
      _meta: meta,
      ...overrides,
    },
  });
  return { channel, respond, pending: channel.interactions("native-thread")[0] };
}

it("presents the native Computer Use consent as an actionable approval, not an empty question", () => {
  const { pending, respond } = fixture({
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    subtitle: "Monitor the app for prompt injection risks.",
    tool_name: "get_app_state",
    tool_params: { app: "com.apple.Safari" },
  });
  expect(pending).toMatchObject({
    kind: "approval",
    interaction: {
      type: "approval",
      title: 'Allow Computer Use to use "Safari"?',
      description: [
        "Monitor the app for prompt injection risks.",
        '```json\n{\n  "tool": "get_app_state",\n  "arguments": {\n    "app": "com.apple.Safari"\n  }\n}\n```',
      ].join("\n\n"),
      subject: {
        serverName: "cua_repl",
        tool: "get_app_state",
        arguments: { app: "com.apple.Safari" },
      },
      actions: [
        { effect: "allowOnce" },
        { effect: "allowForSession" },
        { effect: "allowAlways" },
        { effect: "deny" },
      ],
    },
  });
  expect(respond).not.toHaveBeenCalled();
});

it.each([
  [undefined, ["allowOnce", "deny"]],
  ["session", ["allowOnce", "allowForSession", "deny"]],
  ["always", ["allowOnce", "allowAlways", "deny"]],
  [
    ["session", "unknown"],
    ["allowOnce", "allowForSession", "deny"],
  ],
] as const)("offers only the declared native persistence scopes: %j", (persist, effects) => {
  const { pending } = fixture({
    codex_approval_kind: "mcp_tool_call",
    ...(persist === undefined ? {} : { persist: persist as JsonValue }),
  });
  expect(pending?.interaction.type).toBe("approval");
  if (pending?.interaction.type !== "approval") throw new Error("Missing approval");
  expect(pending.interaction.actions.map((action) => action.effect)).toEqual(effects);
});

it("presents a message-only form as one-time consent without inventing persistence", () => {
  const { pending } = fixture({ persist: ["session", "always"] });
  expect(pending?.kind).toBe("approval");
  if (pending?.interaction.type !== "approval") throw new Error("Missing approval");
  expect(pending.interaction.actions.map((action) => action.effect)).toEqual(["allowOnce", "deny"]);
  expect(pending.interaction.description).toBeUndefined();
});

it.each([
  { action: "accept", content: {} },
  { action: "accept", content: {}, _meta: { persist: "session" } },
  { action: "accept", content: {}, _meta: { persist: "always" } },
  { action: "decline" },
  { action: "cancel" },
])("forwards the selected native elicitation response exactly once: %j", async (answer) => {
  const { channel, pending, respond } = fixture({
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
  });
  if (!pending) throw new Error("Missing approval");
  expect(await channel.respond(pending.requestId, "native-thread", answer)).toBe(true);
  expect(respond).toHaveBeenCalledExactlyOnceWith("native-safari-approval", answer);
  expect(await channel.respond(pending.requestId, "native-thread", answer)).toBe(false);
});

it.each([
  { action: "unknown" },
  { action: "accept", content: { extra: "not reviewed" } },
  { action: "accept", _meta: { persist: "always" } },
  { action: "accept", _meta: { persist: "unknown" } },
  { action: "accept", _meta: { persist: "session", extra: true } },
  { action: "accept", extra: true },
  { action: "decline", _meta: { persist: "session" } },
  { action: "cancel", content: {} },
  { answers: {} },
])("rejects invalid or undeclared consent without consuming the request: %j", async (answer) => {
  const { channel, pending, respond } = fixture({
    codex_approval_kind: "mcp_tool_call",
    persist: "session",
  });
  if (!pending) throw new Error("Missing approval");
  await expect(channel.respond(pending.requestId, "native-thread", answer)).rejects.toThrow();
  expect(respond).not.toHaveBeenCalled();
  expect(channel.interactions("native-thread")).toHaveLength(1);
});

it("retains field-bearing MCP forms as questions", () => {
  const { pending } = fixture(
    {},
    {
      requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } } },
    },
  );
  expect(pending?.interaction).toMatchObject({
    type: "question",
    questions: [{ id: "name", prompt: "Name" }],
  });
});

it.each([
  { mode: "url" },
  { requestedSchema: { type: "object", properties: {}, required: ["missing"] } },
])("leaves unsupported elicitation shapes to Desktop: %j", (overrides) => {
  const { pending, respond } = fixture({ codex_approval_kind: "mcp_tool_call" }, overrides);
  expect(pending).toBeUndefined();
  expect(respond).not.toHaveBeenCalled();
});
