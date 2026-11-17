import { expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { DesktopMcpConfigTransform, rewriteDesktopMcpRequest } from "../src/desktop-mcp-config.js";

const original = { command: "/official/node_repl", env: { source: "provided" } };
const replacement = { url: "http://127.0.0.1:1/fixture", tool_timeout_sec: 45 };
const register = (server: JsonObject) =>
  server.command === original.command ? replacement : undefined;

it.each(["thread/start", "thread/resume", "thread/fork"])(
  "adapts %s MCP configuration and preserves native fields",
  (method) => {
    const params = {
      cwd: "/fixture/workspace",
      future: { value: "untouched" },
      config: { "mcp_servers.node_repl": original, "unrelated.setting": { untouched: true } },
    };
    const input = { id: "native-request", method, params };
    expect(rewriteDesktopMcpRequest(input, register)).toEqual({
      ...input,
      params: { ...params, config: { ...params.config, "mcp_servers.node_repl": replacement } },
    });
    expect(params.config["mcp_servers.node_repl"]).toBe(original);
  },
);

it("adapts nested server tables in per-thread overrides", () => {
  const input = {
    id: 4,
    method: "thread/start",
    params: {
      config: { mcp_servers: { node_repl: original, other: { command: "/other" } } },
    },
  };
  expect(rewriteDesktopMcpRequest(input, register)).toEqual({
    ...input,
    params: {
      config: { mcp_servers: { node_repl: replacement, other: { command: "/other" } } },
    },
  });
});

it("preserves Desktop's wrapped thread parameters and workspace", () => {
  const request = { cwd: "/fixture/wrapped", config: { "mcp_servers.node_repl": original } };
  const input = { id: 5, method: "thread/start", params: { request, future: true } };
  const workspaces: Array<string | undefined> = [];
  expect(
    rewriteDesktopMcpRequest(input, (server, cwd) => {
      workspaces.push(cwd);
      return register(server);
    }),
  ).toEqual({
    ...input,
    params: {
      ...input.params,
      request: { ...request, config: { "mcp_servers.node_repl": replacement } },
    },
  });
  expect(workspaces).toEqual([request.cwd]);
});

it.each([
  {
    method: "config/batchWrite",
    params: { edits: [{ keyPath: "mcp_servers.node_repl", value: original }] },
  },
  { method: "config/value/write", params: { keyPath: "mcp_servers.node_repl", value: original } },
  { method: "future/native-method", params: { config: { "mcp_servers.node_repl": original } } },
  { method: "thread/resume", params: { config: "unknown-shape" } },
  { method: "thread/start", params: { config: { "mcp_servers.other": { command: "/other" } } } },
])("preserves unowned requests by identity", (message) => {
  expect(rewriteDesktopMcpRequest(message, register)).toBe(message);
});

it("preserves untouched bytes, split UTF-8 and unterminated data", async () => {
  const input = Buffer.concat([
    Buffer.from(' { "id": "中文", "method": "future/native" }\r\n'),
    Buffer.from([0xff, 0, 0x0a]),
    Buffer.from("unfinished"),
  ]);
  const transform = new DesktopMcpConfigTransform(register);
  const output: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => output.push(chunk));
  const ended = new Promise<void>((resolve) => transform.once("end", resolve));
  for (let i = 0; i < input.length; i += 3) transform.write(input.subarray(i, i + 3));
  transform.end();
  await ended;
  expect(Buffer.concat(output)).toEqual(input);
});
