import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jsonObjectSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { createDesktopMcpBridge, runDesktopMcpClient } from "../src/desktop-mcp-bridge.js";
import { JsonLineCollector } from "./app-server-host-fixture.js";

const initializationRequest = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "desktop-mcp-test", version: "1" },
  },
};

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: { detachedSessionTimeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "desktop-mcp-test-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const events = path.join(root, "events.jsonl");
  const created = await createDesktopMcpBridge({
    nodeReplPath: process.execPath,
    runtimePath: fileURLToPath(new URL("../dist/release-main.js", import.meta.url)),
    environment: {
      ...process.env,
      HOME: root,
      BROWSER_USE_ACCESS_PIPE_PATH: "synthetic-desktop-pipe",
    },
    ...options,
  });
  if (!created) throw new Error("Missing fixture bridge");
  const bridge = created;
  cleanup.push(() => bridge.close());
  const server = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktop-mcp-server.mjs", import.meta.url))],
    env: {
      NODE_REPL_TRUSTED_SERVICES: '{"browser":"fixture"}',
      FIXTURE_EVENTS: events,
      FIXTURE_MARKER: "provided",
    },
    env_vars: ["BROWSER_USE_ACCESS_PIPE_PATH"],
    tool_timeout_sec: 45,
    default_tools_approval_mode: "prompt",
  };
  async function rewrite(config: JsonObject = server, cwd = root) {
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => chunks.push(chunk);
    bridge.input.on("data", collect);
    await new Promise<void>((resolve, reject) => {
      bridge.input.write(
        JSON.stringify({
          id: 1,
          method: "thread/start",
          params: { cwd, config: { "mcp_servers.node_repl": config }, future: { preserved: true } },
        }) + "\n",
        (error) => (error ? reject(error) : resolve()),
      );
    });
    bridge.input.off("data", collect);
    return JSON.parse(Buffer.concat(chunks).toString()) as {
      params: { config: Record<string, JsonObject>; future: { preserved: boolean } };
    };
  }
  const transformed = await rewrite();
  const config = jsonObjectSchema.parse(transformed.params.config["mcp_servers.node_repl"]);
  function headers(configuration = config) {
    return { Authorization: String((configuration.args as string[])[3]) };
  }
  async function connect(configuration = config, capabilities = {}) {
    const client = new Client({ name: "desktop-mcp-test", version: "1" }, { capabilities });
    const transport = new StreamableHTTPClientTransport(
      new URL(String((configuration.args as string[])[2])),
      {
        requestInit: { headers: headers(configuration) },
      },
    );
    cleanup.push(() => client.close());
    await client.connect(transport as Transport);
    return { client, transport };
  }
  async function records() {
    return (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  function clientArguments() {
    const [, , url, authorization] = config.args as string[];
    const entry = new URL("../src/desktop-mcp-bridge.ts", import.meta.url).href;
    return [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { runDesktopMcpClient } = await import(${JSON.stringify(entry)}); process.exitCode = await runDesktopMcpClient(process.argv.slice(1));`,
      String(url),
      String(authorization),
    ];
  }
  return {
    bridge,
    server,
    config,
    transformed,
    root,
    events,
    rewrite,
    connect,
    records,
    headers,
    clientArguments,
  };
}

it("runs the genuine stdio process below the bridge and preserves metadata and configuration", async () => {
  const f = await setup();
  expect(f.config.command).toBe(process.execPath);
  expect(f.config.env).toEqual(f.server.env);
  expect(f.config.tool_timeout_sec).toBe(45);
  expect(f.config.default_tools_approval_mode).toBe("prompt");
  expect(f.transformed.params.future).toEqual({ preserved: true });
  const { client } = await f.connect();
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "echo",
    "ask",
    "wait",
    "measure",
  ]);
  const result = await client.callTool({
    name: "echo",
    arguments: { input: "hello" },
    _meta: { fixtureCaller: "actual-request-metadata" },
  });
  expect(jsonObjectSchema.parse(result.structuredContent).parent).not.toBe(process.pid);
  expect(result.structuredContent).toMatchObject({
    arguments: { input: "hello" },
    meta: { fixtureCaller: "actual-request-metadata" },
    parent: expect.any(Number),
    cwd: f.root,
    marker: "provided",
    browserPipe: "synthetic-desktop-pipe",
    calls: 1,
  });
});

it("keeps separate MCP sessions independent and terminates their owned processes", async () => {
  const f = await setup();
  const a = await f.connect();
  const b = await f.connect();
  const first = jsonObjectSchema.parse(
    (await a.client.callTool({ name: "echo", arguments: {} })).structuredContent,
  );
  const second = jsonObjectSchema.parse(
    (await b.client.callTool({ name: "echo", arguments: {} })).structuredContent,
  );
  expect(first.pid).not.toBe(second.pid);
  expect(first.calls).toBe(1);
  expect(second.calls).toBe(1);
  await a.transport.terminateSession();
  await vi.waitFor(() => expect(() => process.kill(Number(first.pid), 0)).toThrow());
  expect(
    (await b.client.callTool({ name: "echo", arguments: {} })).structuredContent,
  ).toMatchObject({ calls: 2 });
});

it("forwards concurrent server-initiated elicitation and the client's decision", async () => {
  const f = await setup();
  const client = new Client(
    { name: "elicitation-client", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: "accept",
    content: { allow: true },
  }));
  cleanup.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(String((f.config.args as string[])[2])), {
      requestInit: { headers: f.headers() },
    }) as Transport,
  );
  const results = await Promise.all([
    client.callTool({ name: "ask", arguments: { input: "first" } }),
    client.callTool({ name: "ask", arguments: { input: "second" } }),
  ]);
  expect(results.map((result) => result.structuredContent)).toEqual([
    { action: "accept", content: { allow: true } },
    { action: "accept", content: { allow: true } },
  ]);
});

it("forwards cancellation and retains the session for the next call", async () => {
  const f = await setup();
  const { client } = await f.connect();
  const controller = new AbortController();
  const pending = client.callTool({ name: "wait", arguments: {} }, CallToolResultSchema, {
    signal: controller.signal,
  });
  await vi.waitFor(async () =>
    expect((await f.records()).some((entry) => entry.method === "tools/call")).toBe(true),
  );
  controller.abort(new Error("test cancellation"));
  await expect(pending).rejects.toThrow("test cancellation");
  await vi.waitFor(async () =>
    expect((await f.records()).some((entry) => entry.event === "cancelled")).toBe(true),
  );
  expect((await client.callTool({ name: "echo", arguments: {} })).structuredContent).toMatchObject({
    calls: 1,
  });
});

it("rejects unauthenticated clients and web origins before starting a process", async () => {
  const f = await setup();
  const body = JSON.stringify(initializationRequest);
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  expect(
    (await fetch(String((f.config.args as string[])[2]), { method: "POST", headers, body })).status,
  ).toBe(401);
  expect(
    (
      await fetch(String((f.config.args as string[])[2]), {
        method: "POST",
        headers: {
          ...headers,
          ...f.headers(),
          origin: "https://untrusted.invalid",
        },
        body,
      })
    ).status,
  ).toBe(403);
  await expect(readFile(f.events)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses identical definitions and leaves unsupported servers on their existing transport", async () => {
  const f = await setup();
  expect((await f.rewrite()).params.config["mcp_servers.node_repl"]).toEqual(f.config);
  for (const config of [
    { ...f.server, command: f.server.command + ".missing" },
    { ...f.server, environment_id: "remote-environment" },
    { ...f.server, env: { NODE_REPL_TRUSTED_SERVICES: "{}" } },
  ]) {
    expect((await f.rewrite(config)).params.config["mcp_servers.node_repl"]).toEqual(config);
  }
});

it("carries large authenticated MCP input and rejects requests above the browser limit", async () => {
  const f = await setup();
  const { client } = await f.connect();
  const input = "x".repeat(2 * 1024 * 1024 + 1);
  const result = await client.callTool({ name: "measure", arguments: { input } });
  expect(result.structuredContent).toEqual({ length: input.length });
  await expect(
    client.callTool({ name: "measure", arguments: { input: "x".repeat(16 * 1024 * 1024) } }),
  ).rejects.toThrow();
  const next = await client.callTool({ name: "measure", arguments: { input: "still connected" } });
  expect(next.structuredContent).toEqual({ length: 15 });
  expect((await f.records()).filter((record) => record.method === "tools/call")).toHaveLength(2);
});

it.skipIf(process.platform === "win32")(
  "resolves enabled native and plugin definitions and retains native configuration flags",
  async () => {
    const f = await setup();
    const executable = path.join(f.root, "native-config");
    const recorded = path.join(f.root, "native-arguments.json");
    const globalPolicyMarker = path.join(f.root, "global-cua-policy");
    const pluginEnvironment = { ...f.server.env, BROWSER_USE_CODEX_APP_VERSION: "fixture1" };
    const servers = [
      { name: "node_repl", enabled: true, transport: { ...f.server, type: "stdio", cwd: null } },
      {
        name: "cua_repl",
        enabled: true,
        transport: {
          ...f.server,
          type: "stdio",
          command: "/bin/sh",
          env: pluginEnvironment,
          args: [
            "-c",
            'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"',
            "cua-repl",
            process.execPath,
          ],
        },
      },
      { name: "disabled", enabled: false, transport: { ...f.server, type: "stdio" } },
      {
        name: "unrelated",
        enabled: true,
        transport: { ...f.server, type: "stdio", command: "/bin/echo" },
      },
    ];
    const pluginDirectory = path.join(f.root, "plugins/cache/openai-bundled/fixture/fixture1");
    await mkdir(pluginDirectory, { recursive: true });
    const cua = servers.find((server) => server.name === "cua_repl");
    if (!cua) throw new Error("Missing CUA fixture");
    const transportDefinition = Object.fromEntries(
      Object.entries(cua.transport).filter(([key]) => key !== "type"),
    );
    await writeFile(
      path.join(pluginDirectory, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cua_repl: {
            ...transportDefinition,
            enabled_tools: ["js", "js_reset", "turn_ended"],
            omit_tools_from: ["code_mode", "deferred"],
            startup_timeout_sec: 120,
            tools: { js: { output_token_limit: 25000 } },
          },
        },
      }),
    );
    await writeFile(
      executable,
      `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const servers = ${JSON.stringify(servers)};
process.stdout.write(JSON.stringify(process.argv.includes("features.plugins=false") && !require("node:fs").existsSync(${JSON.stringify(globalPolicyMarker)}) ? servers.filter((server) => server.name !== "cua_repl") : servers));
`,
      { mode: 0o700 },
    );
    const bridge = await createDesktopMcpBridge({
      nodeReplPath: process.execPath,
      runtimePath: fileURLToPath(new URL("../dist/release-main.js", import.meta.url)),
      environment: { ...process.env, CODEX_HOME: f.root },
      native: {
        executable,
        arguments: ["-c", "features.fixture=true", "app-server", "--analytics-default-enabled"],
      },
    });
    if (!bridge) throw new Error("Fixture bridge unavailable");
    cleanup.push(() => bridge.close());
    const overrides = JSON.parse(
      String(bridge.environment.CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS),
    ) as string[];
    expect(overrides.filter((value) => value !== "-c").map((value) => value.split("=")[0])).toEqual(
      [
        "mcp_servers.node_repl.command",
        "mcp_servers.node_repl.args",
        "mcp_servers.cua_repl.command",
        "mcp_servers.cua_repl.args",
        "mcp_servers.cua_repl.tool_timeout_sec",
        "mcp_servers.cua_repl.default_tools_approval_mode",
        "mcp_servers.cua_repl.enabled_tools",
        "mcp_servers.cua_repl.omit_tools_from",
        "mcp_servers.cua_repl.startup_timeout_sec",
        "mcp_servers.cua_repl.tools",
      ],
    );
    expect(overrides.join("\n")).toContain(
      'mcp_servers.cua_repl.enabled_tools=["js","js_reset","turn_ended"]',
    );
    expect(overrides.join("\n")).toContain(
      'mcp_servers.cua_repl.tools={"js"={"output_token_limit"=25000}}',
    );
    expect(
      (await readFile(recorded, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      expect.arrayContaining([
        ["-c", "features.fixture=true", "mcp", "list", "--json"],
        ["-c", "features.fixture=true", "-c", "features.plugins=false", "mcp", "list", "--json"],
      ]),
    );
    await writeFile(globalPolicyMarker, "global definition already supplies its tool policy");
    const globalPolicy = await createDesktopMcpBridge({
      nodeReplPath: process.execPath,
      runtimePath: fileURLToPath(new URL("../dist/release-main.js", import.meta.url)),
      environment: { ...process.env, CODEX_HOME: f.root },
      native: { executable, arguments: [] },
    });
    if (!globalPolicy) throw new Error("Fixture bridge unavailable");
    cleanup.push(() => globalPolicy.close());
    const globalOverrides = (
      JSON.parse(
        String(globalPolicy.environment.CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS),
      ) as string[]
    )
      .filter((argument) => argument !== "-c")
      .map((argument) => argument.split("=")[0]);
    expect(globalOverrides).toContain("mcp_servers.cua_repl.command");
    expect(globalOverrides).not.toContain("mcp_servers.cua_repl.enabled_tools");
    expect(globalOverrides).not.toContain("mcp_servers.cua_repl.default_tools_approval_mode");
    await rm(globalPolicyMarker);
    await rm(path.join(pluginDirectory, ".mcp.json"));
    const unavailablePolicy = await createDesktopMcpBridge({
      nodeReplPath: process.execPath,
      runtimePath: fileURLToPath(new URL("../dist/release-main.js", import.meta.url)),
      environment: { ...process.env, CODEX_HOME: f.root },
      native: { executable, arguments: [] },
    });
    if (!unavailablePolicy) throw new Error("Fixture bridge unavailable");
    cleanup.push(() => unavailablePolicy.close());
    const skipped = String(unavailablePolicy.environment.CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS);
    expect(skipped).toContain("mcp_servers.node_repl.command");
    expect(skipped).not.toContain("mcp_servers.cua_repl");
  },
);

it.skipIf(process.platform === "win32")(
  "bridges bundled codex-app-tools MCP, preserves approval policy, and rejects untrusted entries",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "desktop-app-tools-test-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const pluginDir = path.join(root, "plugins/cache/openai-bundled/codex-app-tools/26.1120.41243");
    const scriptsDir = path.join(pluginDir, "scripts");
    await mkdir(scriptsDir, { recursive: true });
    const launcher = path.join(scriptsDir, "launch_codex_app_tools_mcp");
    const serverScript = path.join(pluginDir, "server.mjs");
    await writeFile(
      launcher,
      `#!/bin/sh
set -eu
exec "$CODEX_MCP_NODE_PATH" "$@"
`,
      { mode: 0o700 },
    );
    await writeFile(
      serverScript,
      `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-app-tools-fixture", version: "1" },
      },
    }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "list_threads", inputSchema: { type: "object", properties: {} } }] },
    }) + "\\n");
  } else if (message.method === "tools/call") {
    const value = {
      pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
      mcpNode: process.env.CODEX_MCP_NODE_PATH,
      deferred: process.env.CODEX_APP_TOOLS_DEFERRED,
      cwd: process.cwd(),
      argv: process.argv.slice(1),
      meta: message.params._meta,
    };
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    }) + "\\n");
  }
}
`,
    );
    const transportDefinition = {
      command: launcher,
      args: ["./server.mjs"],
      cwd: pluginDir,
      env: { CODEX_APP_TOOLS_DEFERRED: "1" },
      env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "PATH"],
    };
    await writeFile(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          codex_app: {
            ...transportDefinition,
            enabled: false,
            omit_tools_from: [],
            default_tools_approval_mode: "approve",
            tools: { create_thread: { approval_mode: "prompt" } },
            startup_timeout_sec: 10,
            tool_timeout_sec: 3600,
          },
        },
      }),
    );
    const nativeCli = path.join(root, "native-codex");
    const listedServers = [
      {
        name: "codex_app",
        enabled: true,
        transport: { ...transportDefinition, type: "stdio" },
        startup_timeout_sec: 10,
        tool_timeout_sec: 3600,
      },
    ];
    await writeFile(
      nativeCli,
      `#!${process.execPath}
process.stdout.write(JSON.stringify(process.argv.includes("features.plugins=false") ? [] : ${JSON.stringify(listedServers)}));
`,
      { mode: 0o700 },
    );
    const bridgeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: root,
      CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-app-tools/fixture.sock",
    };
    delete bridgeEnvironment.CODEX_MCP_NODE_PATH;
    const bridge = await createDesktopMcpBridge({
      nodeReplPath: path.join(root, "missing-node-repl"),
      runtimePath: fileURLToPath(new URL("../dist/release-main.js", import.meta.url)),
      environment: bridgeEnvironment,
      native: {
        executable: nativeCli,
        arguments: [
          "-c",
          "features.code_mode_host=true",
          "app-server",
          "--analytics-default-enabled",
          "-c",
          "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
        ],
      },
    });
    if (!bridge) throw new Error("App-tools bridge unavailable");
    cleanup.push(() => bridge.close());

    const overrides = JSON.parse(
      String(bridge.environment.CODEXHOST_DESKTOP_BROWSER_MCP_ARGUMENTS),
    ) as string[];
    const overrideMap = new Map(
      overrides
        .filter((value) => value !== "-c")
        .map((value) => {
          const index = value.indexOf("=");
          return [value.slice(0, index), value.slice(index + 1)];
        }),
    );
    expect(overrideMap.get("mcp_servers.codex_app.enabled")).toBe("true");
    expect(overrideMap.get("mcp_servers.codex_app.default_tools_approval_mode")).toBe('"approve"');
    expect(overrideMap.get("mcp_servers.codex_app.tools")).toBe(
      '{"create_thread"={"approval_mode"="prompt"}}',
    );
    expect(overrideMap.get("mcp_servers.codex_app.startup_timeout_sec")).toBe("10");
    expect(overrideMap.get("mcp_servers.codex_app.tool_timeout_sec")).toBe("3600");

    const clientArgs = JSON.parse(
      String(overrideMap.get("mcp_servers.codex_app.args")),
    ) as string[];
    const client = new Client({ name: "app-tools-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(String(clientArgs[2])), {
      requestInit: { headers: { Authorization: String(clientArgs[3]) } },
    });
    cleanup.push(() => client.close());
    await client.connect(transport as Transport);
    const result = await client.callTool({
      name: "list_threads",
      arguments: {},
      _meta: { threadId: "fixture-thread" },
    });
    expect(result.structuredContent).toEqual({
      pipePath: "/tmp/codex-app-tools/fixture.sock",
      mcpNode: process.execPath,
      deferred: "1",
      cwd: pluginDir,
      argv: [serverScript],
      meta: { threadId: "fixture-thread" },
    });

    const rewriteThreadConfig = async (
      candidate: JsonObject,
      threadCwd?: string,
    ): Promise<JsonObject> => {
      const chunks: Buffer[] = [];
      const collect = (chunk: Buffer) => chunks.push(chunk);
      bridge.input.on("data", collect);
      await new Promise<void>((resolve, reject) => {
        bridge.input.write(
          JSON.stringify({
            id: 2,
            method: "thread/start",
            params: {
              ...(threadCwd === undefined ? {} : { cwd: threadCwd }),
              config: { "mcp_servers.codex_app": candidate },
            },
          }) + "\n",
          (error) => (error ? reject(error) : resolve()),
        );
      });
      bridge.input.off("data", collect);
      const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
        params: { config: Record<string, JsonObject> };
      };
      const rewritten = parsed.params.config["mcp_servers.codex_app"];
      if (!rewritten) throw new Error("Missing rewritten codex_app config");
      return rewritten;
    };

    // Omitting cwd must still pin execution cwd and entrypoint to the validated plugin directory,
    // never resolving a relative ./server.mjs against threadCwd.
    const decoyDir = path.join(root, "decoy-thread-cwd");
    await mkdir(decoyDir, { recursive: true });
    await writeFile(
      path.join(decoyDir, "server.mjs"),
      'throw new Error("Decoy server.mjs in threadCwd must never execute");\n',
    );
    const withoutCwd = {
      command: transportDefinition.command,
      args: transportDefinition.args,
      env: transportDefinition.env,
      env_vars: transportDefinition.env_vars,
    };
    const omittedCwdRewritten = await rewriteThreadConfig(
      {
        ...withoutCwd,
        args: ["./server.mjs", "--interaction-client-id", "client-1"],
        env: {
          ...withoutCwd.env,
          CODEX_MCP_NODE_PATH: path.join(decoyDir, "evil-node"),
          CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-app-tools/untrusted.sock",
        },
      },
      decoyDir,
    );
    const omittedCwdArgs = omittedCwdRewritten.args as string[];
    const omittedCwdClient = new Client({ name: "app-tools-omitted-cwd", version: "1" });
    const omittedCwdTransport = new StreamableHTTPClientTransport(
      new URL(String(omittedCwdArgs[2])),
      { requestInit: { headers: { Authorization: String(omittedCwdArgs[3]) } } },
    );
    cleanup.push(() => omittedCwdClient.close());
    await omittedCwdClient.connect(omittedCwdTransport as Transport);
    const omittedCwdResult = await omittedCwdClient.callTool({
      name: "list_threads",
      arguments: {},
    });
    expect(omittedCwdResult.structuredContent).toEqual({
      pipePath: "/tmp/codex-app-tools/fixture.sock",
      mcpNode: process.execPath,
      deferred: "1",
      cwd: pluginDir,
      argv: [serverScript, "--interaction-client-id", "client-1"],
    });

    // Relative command paths inside the validated plugin directory must also be bridged.
    const relativeCommandRewritten = await rewriteThreadConfig({
      ...transportDefinition,
      command: "./scripts/launch_codex_app_tools_mcp",
    });
    expect(relativeCommandRewritten.command).toBe(process.execPath);
    expect((relativeCommandRewritten.args as string[])[1]).toBe("--codexhost-desktop-mcp-client");

    // Reject untrusted paths, missing pipe env_vars, or non-server.mjs entrypoints.
    const untrustedScript = path.join(root, "evil.mjs");
    await writeFile(untrustedScript, "process.exit(0);\n");
    for (const candidate of [
      { ...transportDefinition, command: nativeCli },
      { ...transportDefinition, args: [untrustedScript] },
      { ...transportDefinition, env_vars: ["PATH"] },
      { ...transportDefinition, cwd: root },
      { ...withoutCwd, command: "./scripts/launch_codex_app_tools_mcp" },
    ]) {
      expect(await rewriteThreadConfig(candidate)).toEqual(candidate);
    }
  },
);

it("retains the native stdio MCP contract through the HTTP client process", async () => {
  const f = await setup();
  const client = new Client({ name: "stdio-contract", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: f.clientArguments(),
    stderr: "pipe",
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({
    name: "echo",
    arguments: { input: "stdio" },
    _meta: { original: "caller-metadata" },
  });
  expect(result.structuredContent).toMatchObject({
    arguments: { input: "stdio" },
    meta: { original: "caller-metadata" },
    parent: expect.any(Number),
  });
  const input = "x".repeat(11 * 1024 * 1024);
  const measured = await client.callTool({ name: "measure", arguments: { input } });
  expect(measured.structuredContent).toEqual({ length: input.length });
}, 20_000);

it.each(["\n", "\r\n"])(
  "bounds individual stdio frames when adjacent requests share a read (%j)",
  async (ending) => {
    const f = await setup();
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = new JsonLineCollector(output);
    const connection = runDesktopMcpClient((f.config.args as string[]).slice(2), { input, output });
    cleanup.push(async () => {
      input.end();
      await connection;
    });
    input.write(JSON.stringify(initializationRequest) + ending);
    await messages.waitFor((message) => message.id === 0, 10_000);
    input.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + ending,
    );
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "measure", arguments: { input: "" } },
    };
    const limit = 16 * 1024 * 1024;
    request.params.arguments.input = "x".repeat(limit - Buffer.byteLength(JSON.stringify(request)));
    const frame = Buffer.from(JSON.stringify(request));
    const next = {
      ...request,
      id: 2,
      params: { name: "measure", arguments: { input: "next frame" } },
    };
    expect(frame.length).toBe(limit);
    input.write(frame.subarray(0, frame.length - 32));
    input.write(
      Buffer.concat([
        frame.subarray(frame.length - 32),
        Buffer.from(ending + JSON.stringify(next) + ending),
      ]),
    );
    const first = await messages.waitFor((message) => message.id === 1, 10_000);
    const second = await messages.waitFor((message) => message.id === 2, 10_000);
    expect(jsonObjectSchema.parse(first.result).structuredContent).toEqual({
      length: request.params.arguments.input.length,
    });
    expect(jsonObjectSchema.parse(second.result).structuredContent).toEqual({ length: 10 });
    input.write(Buffer.alloc(limit + 2, "x"));
    expect(await connection).toBe(1);
    expect((await f.records()).filter((record) => record.method === "tools/call")).toHaveLength(2);
  },
  20_000,
);

it("reaps initialization that finishes after its HTTP client disconnects", async () => {
  const f = await setup();
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const disconnected = Promise.withResolvers<undefined>();
  const originalStart = StdioClientTransport.prototype.start;
  let toolHostPid: number | null = null;
  const start = vi
    .spyOn(StdioClientTransport.prototype, "start")
    .mockImplementationOnce(async function (this: StdioClientTransport) {
      entered.resolve(undefined);
      await released.promise;
      await originalStart.call(this);
      toolHostPid = this.pid;
    });
  const url = String((f.config.args as string[])[2]);
  const originalEmit = ServerResponse.prototype.emit;
  const events = vi.spyOn(ServerResponse.prototype, "emit").mockImplementation(function (
    this: ServerResponse,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "close" && this.req.url === new URL(url).pathname)
      disconnected.resolve(undefined);
    return originalEmit.call(this, event, ...args);
  });
  const controller = new AbortController();
  const request = fetch(url, {
    method: "POST",
    headers: {
      ...f.headers(),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(initializationRequest),
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    await entered.promise;
    controller.abort();
    await disconnected.promise;
    released.resolve(undefined);
    await request;
    await vi.waitFor(
      () => {
        expect(toolHostPid).not.toBeNull();
        expect(() => process.kill(Number(toolHostPid), 0)).toThrow();
      },
      // Allow the SDK's EOF/SIGTERM grace periods and the bridge's exit confirmation.
      { timeout: 6_000 },
    );
  } finally {
    released.resolve(undefined);
    controller.abort();
    start.mockRestore();
    events.mockRestore();
  }
}, 20_000);

it("releases the remote session when the stdio client receives EOF", async () => {
  const f = await setup();
  const child = spawn(process.execPath, f.clientArguments(), { stdio: "pipe" });
  child.stderr.on("data", () => {});
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const messages = new JsonLineCollector(child.stdout.pipe(new PassThrough()));
  child.stdin.write(JSON.stringify(initializationRequest) + "\n");
  await messages.waitFor((message) => message.id === 0, 10_000);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    }) + "\n",
  );
  const reply = await messages.waitFor((message) => message.id === 1, 10_000);
  const content = jsonObjectSchema.parse(jsonObjectSchema.parse(reply.result).structuredContent);
  child.stdin.end();
  await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 6_000 });
  await vi.waitFor(() => expect(() => process.kill(Number(content.pid), 0)).toThrow(), {
    timeout: 6_000,
  });
}, 20_000);

it("reaps a session whose client died without DELETE and keeps connected idle sessions", async () => {
  const f = await setup({ detachedSessionTimeoutMs: 500 });
  const connected = await f.connect();
  const kept = jsonObjectSchema.parse(
    (await connected.client.callTool({ name: "echo", arguments: {} })).structuredContent,
  );
  const child = spawn(process.execPath, f.clientArguments(), { stdio: "pipe" });
  child.stderr.on("data", () => {});
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const messages = new JsonLineCollector(child.stdout.pipe(new PassThrough()));
  child.stdin.write(JSON.stringify(initializationRequest) + "\n");
  await messages.waitFor((message) => message.id === 0, 10_000);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    }) + "\n",
  );
  const reply = await messages.waitFor((message) => message.id === 1, 10_000);
  const abandoned = jsonObjectSchema.parse(jsonObjectSchema.parse(reply.result).structuredContent);
  // A killed client cannot run its cleanup, so the bridge sees only its connections closing.
  child.kill("SIGKILL");
  await vi.waitFor(() => expect(() => process.kill(Number(abandoned.pid), 0)).toThrow(), {
    timeout: 6_000,
  });
  expect(
    (await connected.client.callTool({ name: "echo", arguments: {} })).structuredContent,
  ).toMatchObject({ pid: kept.pid, calls: 2 });
}, 20_000);

it("keeps a session without SSE alive while a POST body is still arriving", async () => {
  const timeout = 500;
  const f = await setup({ detachedSessionTimeoutMs: timeout });
  const url = String((f.config.args as string[])[2]);
  const headers = {
    ...f.headers(),
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const initialized = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(initializationRequest),
    });
    expect(initialized.status).toBe(200);
    await initialized.text();
    const sessionId = initialized.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("Missing MCP session ID");
    const upload = httpRequest(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId, expect: "100-continue" },
    });
    try {
      const ready = once(upload, "continue");
      upload.flushHeaders();
      await ready;
      upload.write('{"jsonrpc":"2.0","method":"notifications/initialized"');
      await vi.advanceTimersByTimeAsync(timeout * 2);
      const reply = once(upload, "response");
      upload.end("}");
      const [response] = await reply;
      response.resume();
      expect(response.statusCode).toBe(202);

      // Once the POST ends, the session can be reaped again.
      await vi.advanceTimersByTimeAsync(timeout);
    } finally {
      upload.destroy();
    }
  } finally {
    vi.useRealTimers();
  }
  const pid = (await f.records()).find((record) => record.event === "started")?.pid;
  expect(pid).toEqual(expect.any(Number));
  await vi.waitFor(() => expect(() => process.kill(Number(pid), 0)).toThrow(), { timeout: 6_000 });
}, 20_000);

it("stops an owned tool that ignores EOF and termination", async () => {
  const f = await setup();
  const rewritten = await f.rewrite({
    ...f.server,
    env: { ...f.server.env, FIXTURE_IGNORE_SHUTDOWN: "1" },
  });
  const config = jsonObjectSchema.parse(rewritten.params.config["mcp_servers.node_repl"]);
  const { client, transport } = await f.connect(config);
  const content = jsonObjectSchema.parse(
    (await client.callTool({ name: "echo", arguments: {} })).structuredContent,
  );
  cleanup.push(async () => {
    try {
      process.kill(Number(content.pid), "SIGKILL");
    } catch {
      /* The owned tool already exited. */
    }
  });
  const started = Date.now();
  await transport.terminateSession();
  expect(Date.now() - started).toBeLessThan(3_000);
  await vi.waitFor(() => expect(() => process.kill(Number(content.pid), 0)).toThrow());
  if (process.platform !== "win32")
    expect((await f.records()).some((entry) => entry.event === "ignored-termination")).toBe(true);
});

it("drains tool output before the tool host exits", async () => {
  const entry = new URL("../src/desktop-mcp-bridge.ts", import.meta.url).href;
  const payloadSize = 2 * 1024 * 1024;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { runDesktopMcpServer } = await import(${JSON.stringify(entry)}); process.exitCode = await runDesktopMcpServer(process.argv.slice(1));`,
      process.execPath,
      "--input-type=module",
      "--eval",
      `process.stdout.write(Buffer.alloc(${payloadSize}, "x"), () => process.exit(0));`,
    ],
    { stdio: "pipe" },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  child.stderr.on("data", () => {});
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    output.push(chunk);
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 5);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  expect(child.exitCode).toBe(0);
  const bytes = Buffer.concat(output);
  expect(bytes.length).toBe(payloadSize);
  expect(bytes.every((byte) => byte === 0x78)).toBe(true);
});
