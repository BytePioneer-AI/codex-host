import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { NativeMcpExecutions } = createRequire(import.meta.url)("../assets/companion/mcp.cjs");

const callback = () => ({
  chatSessionId: "session",
  messageId: "user",
  toolcallId: "llm-call",
  extensionId: "mcp.config.ws0.echo",
  toolName: "echo",
  args: { marker: "owned" },
  workspaceFolders: ["/workspace"],
  rwFolders: ["/workspace"],
});

function setup() {
  const executions = new NativeMcpExecutions();
  const observer = executions.watch("session", ["/workspace"]);
  executions.catalog(
    { chatSessionId: "session", workspaceFolders: ["/workspace"] },
    { code: 0, data: [{ id: "mcp.config.ws0.echo", label: "echo", tools: [{ name: "echo" }] }] },
  );
  const event = {
    event: "plan_item",
    payload: {
      id: "plan",
      reply_to_message_id: "user",
      tool_call_info: {
        id: "plan",
        name: "run_mcp",
        params: { server_name: "mcp_echo", tool_name: "echo", args: { marker: "owned" } },
        result: {},
        meta: { llm_toolcall_id: "llm-call" },
      },
    },
  };
  executions.observe(observer, event);
  return { executions, observer, event };
}

describe("TRAE CN native MCP callback ownership", () => {
  it("admits only the observed execution and never reopens it after an updated event", () => {
    const { executions, observer, event } = setup();
    expect(executions.claim(callback())).toEqual(callback());
    expect(() => executions.claim(callback())).toThrow();
    executions.observe(observer, event);
    expect(() => executions.claim(callback())).toThrow();
  });

  it.each([
    { chatSessionId: "other" },
    { messageId: "other" },
    { toolcallId: "other" },
    { extensionId: "mcp.config.ws0.other" },
    { toolName: "other" },
    { args: { marker: "changed" } },
    { workspaceFolders: ["/other"] },
    { rwFolders: ["/outside"] },
    { rwFolders: ["/workspace", "/outside"] },
    { rwFolders: "/workspace" },
    { source: "app" },
  ])("rejects a callback with mismatched or privileged selectors: %j", (change) => {
    const { executions } = setup();
    expect(() => executions.claim({ ...callback(), ...change })).toThrow();
    // A rejected foreign callback must not consume the real execution.
    expect(executions.claim(callback())).toEqual(callback());
  });

  it("does not execute while native approval is pending, then follows native confirmation", () => {
    const { executions, observer, event } = setup();
    executions.observe(observer, {
      ...event,
      payload: { ...event.payload, confirm_info: { confirm_status: "unconfirmed" } },
    });
    expect(() => executions.claim(callback())).toThrow();
    executions.observe(observer, {
      ...event,
      payload: { ...event.payload, confirm_info: { confirm_status: "confirmed" } },
    });
    expect(executions.claim(callback())).toEqual(callback());
  });

  it("requires the loaded native catalog, including matching server and tool", () => {
    const { executions } = setup();
    executions.catalog(
      { chatSessionId: "session", workspaceFolders: ["/workspace"] },
      { code: 0, data: [{ id: "mcp.config.ws0.echo", label: "other", tools: [{ name: "echo" }] }] },
    );
    expect(() => executions.claim(callback())).toThrow();
  });

  it("expires completed, cancelled and detached-then-closed executions", () => {
    for (const terminal of ["success", "failed", "cancelled"]) {
      const { executions, observer, event } = setup();
      executions.observe(observer, {
        ...event,
        payload: {
          ...event.payload,
          tool_call_info: { ...event.payload.tool_call_info, result: { status: terminal } },
        },
      });
      expect(() => executions.claim(callback())).toThrow();
      executions.observe(observer, event);
      expect(() => executions.claim(callback())).toThrow();
    }
    const { executions, observer } = setup();
    executions.unwatch(observer);
    expect(() => executions.claim(callback())).toThrow();
  });

  it("rejects callbacks after Turn completion without affecting another observed Session", () => {
    const { executions, observer, event } = setup();
    const other = executions.watch("other", ["/other"]);
    executions.observe(observer, { event: "done" });
    executions.observe(observer, event);
    expect(() => executions.claim(callback())).toThrow();
    executions.unwatch(other);
  });

  it("does not accept a catalog from a different workspace or a failed native lookup", () => {
    const { executions } = setup();
    executions.catalog(
      { chatSessionId: "session", workspaceFolders: ["/other"] },
      { code: 0, data: [{ id: "mcp.config.ws0.echo", label: "other", tools: [{ name: "echo" }] }] },
    );
    expect(executions.claim(callback())).toEqual(callback());
    const second = setup();
    second.executions.catalog(
      { chatSessionId: "session", workspaceFolders: ["/workspace"] },
      { code: 1, data: [] },
    );
    expect(() => second.executions.claim(callback())).toThrow();
  });
});
