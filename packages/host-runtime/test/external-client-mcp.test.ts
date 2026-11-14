import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DelegationControlError, type DelegationControlApi } from "../src/delegation-types.js";
import { exportDelegationThread, type ThreadExportInput } from "../src/delegation-thread-export.js";
import { ClientEventLog } from "../src/external-client-events.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";
import { HostInventory } from "../src/host-inventory.js";

describe("external client MCP endpoint", () => {
  let directory: string;
  let server: ExternalClientServer | undefined;
  let token: string;
  const api = {
    exportThread: (input: ThreadExportInput) =>
      exportDelegationThread(
        input,
        {
          threadId: input.threadId,
          harnessId: "codex",
          thread: { id: input.threadId, title: "Native export" },
          turns: [{ id: "turn-1", items: [{ type: "reasoning", text: "native-reasoning" }] }],
          running: false,
        },
        { CODEXHOST_DATA_DIR: directory },
      ),
    read: vi.fn(async () => ({
      threadId: "t1",
      harnessId: "codex",
      cwd: directory,
      status: "completed",
      result: { availability: "available", text: "[result](result.bin)" },
    })),
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex", "pi"] })),
    start: vi.fn(async (input: Record<string, unknown>) => ({
      delegationId: "d1",
      threadId: "t1",
      turnId: "turn",
      harnessId: "pi",
      deepLink: "codex://threads/t1",
      status: "running",
      parentThreadId: input.parentThreadId,
      next: { read: "read", wait: "wait" },
    })),
    wait: vi.fn(async (input: Record<string, unknown>) => ({ ...input, timedOut: true })),
    send: vi.fn(async () => {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }),
  };

  async function connect(authorization = `Bearer ${token}`): Promise<Client> {
    if (!server) throw new Error("listener did not start");
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.endpoint), {
      requestInit: { headers: { authorization } },
    });
    // The SDK's own types do not satisfy exactOptionalPropertyTypes; the objects are compatible.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return client;
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-mcp-"));
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    ({ token } = await clients.add("grok-bot"));
    const events = new ClientEventLog({
      directory: path.join(directory, "events"),
      retentionDays: 7,
    });
    await events.append("grok-bot", [
      { type: "watch", threadId: "t0", outcome: "completed", deepLink: "codex://threads/t0" },
    ]);
    const route = externalClientRouter({
      api: api as unknown as DelegationControlApi,
      events,
      inventory: new HostInventory({
        ...process.env,
        CODEXHOST_DATA_DIR: directory,
        HOME: directory,
      }),
    });
    server = await startExternalClientServer({
      port: 0,
      clients,
      route,
      streams: { "/mcp": externalClientMcp(route) },
      descriptorPath: path.join(directory, "endpoint.json"),
    });
  });
  afterEach(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("lists the delegation tools to an authorized MCP client", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "host_info",
      "project_list",
      "harness_list",
      "harness_inspect",
      "delegate_start",
      "thread_read",
      "thread_export",
      "thread_file_read",
      "thread_wait",
      "thread_list",
      "thread_send",
      "thread_cancel",
      "thread_watch",
      "thread_watches",
      "events_poll",
    ]);
    expect(tools.find((tool) => tool.name === "thread_send")).toMatchObject({
      description: expect.stringContaining("interrupt=true"),
      inputSchema: {
        properties: {
          interrupt: { type: "boolean" },
          watch: { type: "boolean" },
          watchTimeoutMs: { type: "integer", minimum: 1 },
        },
      },
    });
    expect(tools.find((tool) => tool.name === "delegate_start")).toMatchObject({
      description: expect.stringContaining("details.worktree"),
      inputSchema: {
        properties: {
          worktree: { type: "string" },
          base: { type: "string" },
          watch: { type: "boolean" },
          watchTimeoutMs: { type: "integer", minimum: 1 },
        },
      },
    });
    expect(tools.find((tool) => tool.name === "thread_watches")?.description).toContain(
      "watchedForMs",
    );
    await client.close();
  });

  it("forwards absolute Turn bounds for read/wait and rejects invalid and removed arguments", async () => {
    api.read.mockClear();
    api.wait.mockClear();
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ["thread_read", "thread_wait"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema.properties;
      expect(schema).toMatchObject({
        from: { type: "integer", minimum: 1 },
        to: { type: "integer", minimum: 1 },
      });
      expect(schema).not.toHaveProperty("cursor");
      expect(schema).not.toHaveProperty("limit");
      const result = await client.callTool({
        name,
        arguments: { thread: "t1", view: "messages", from: 2, to: 4 },
      });
      expect(result.isError).toBe(false);
      expect(name === "thread_read" ? api.read : api.wait).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "t1", view: "messages", from: 2, to: 4 }),
      );
      for (const bounds of [
        { from: 0 },
        { to: 1.5 },
        { from: 4, to: 2 },
        { cursor: "old" },
        { limit: 10 },
      ]) {
        expect(
          (
            await client.callTool({
              name,
              arguments: { thread: "t1", view: "messages", ...bounds },
            })
          ).isError,
        ).toBe(true);
      }
    }
    await client.close();
  });

  it("allows authenticated clients to discover projects and validates arguments", async () => {
    await writeFile(
      path.join(directory, "host-inventory.json"),
      JSON.stringify({
        id: "test-host",
        projectRoots: [],
      }),
    );
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    const reader = await clients.add("inventory-reader");
    const client = await connect(`Bearer ${reader.token}`);
    await expect(client.callTool({ name: "project_list", arguments: {} })).resolves.toMatchObject({
      isError: false,
      structuredContent: { deviceId: "test-host", projects: [], total: 0, nextOffset: null },
    });
    const invalid = await client.callTool({ name: "project_list", arguments: { limit: 101 } });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it("calls tools with the client's identity and returns the CLI's JSON", async () => {
    const client = await connect();
    await expect(client.callTool({ name: "harness_list", arguments: {} })).resolves.toMatchObject({
      isError: false,
      structuredContent: { harnesses: ["codex", "pi"] },
    });
    const started = await client.callTool({
      name: "delegate_start",
      arguments: {
        harnessId: "pi",
        task: "triage",
        cwd: "/w",
        refs: ["https://e.com/1"],
        model: "m",
        thinking: "high",
      },
    });
    expect(started).toMatchObject({
      isError: false,
      structuredContent: { parentThreadId: "client:grok-bot" },
    });
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: "client:grok-bot",
        refs: ["https://e.com/1"],
        model: "m",
        thinking: "high",
      }),
    );
    // Waits are capped so a tool call never outlives the client's timeout.
    await client.callTool({
      name: "thread_wait",
      arguments: { thread: "codex://threads/t1", timeoutMs: 600_000 },
    });
    expect(api.wait).toHaveBeenCalledWith({ threadId: "t1", view: "result", timeoutMs: 60_000 });
    await expect(
      client.callTool({ name: "events_poll", arguments: { after: 0 } }),
    ).resolves.toMatchObject({
      structuredContent: { events: [{ threadId: "t0", outcome: "completed" }] },
    });
    await client.close();
  });

  it("exports to a Host file through authenticated HTTP and MCP, returning only metadata", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "thread_export",
        arguments: { thread: "codex://threads/t1" },
      });
      expect(result).toMatchObject({
        isError: false,
        structuredContent: { threadId: "t1", harnessId: "codex", turns: 1, complete: true },
      });
      expect(JSON.stringify(result)).not.toContain("native-reasoning");
      const summary = result.structuredContent as { path: string };
      expect(JSON.parse(await readFile(summary.path, "utf8")).turns[0].items[0].type).toBe(
        "reasoning",
      );
      const out = path.join(directory, "http-export.json");
      await writeFile(out, "old content");
      const response = await fetch(new URL("/v1/thread/export", server?.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: "t1", out }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ threadId: "t1", path: out, complete: true });
      expect(JSON.stringify(body)).not.toContain("native-reasoning");
      expect(JSON.parse(await readFile(out, "utf8")).turns).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("transfers linked result bytes through the authenticated MCP endpoint", async () => {
    const bytes = Buffer.from([0, 255, 10, 128]);
    await writeFile(path.join(directory, "result.bin"), bytes);
    const client = await connect();
    const result = await client.callTool({
      name: "thread_file_read",
      arguments: { thread: "codex://threads/t1", path: "result.bin" },
    });
    expect(result).toMatchObject({
      isError: false,
      structuredContent: {
        filename: "result.bin",
        encoding: "base64",
        data: bytes.toString("base64"),
        eof: true,
      },
    });
    const denied = await client.callTool({
      name: "thread_file_read",
      arguments: { thread: "t1", path: "clients.json" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    await client.close();
  });

  it("reports delegation errors as tool errors with the CLI's codes", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "thread_send",
      arguments: { thread: "t1", message: "go" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}")).toEqual({
      error: { code: "THREAD_BUSY", message: "Thread already has an active Turn" },
    });
    await client.close();
  });

  it("rejects a connection without a valid client token", async () => {
    await expect(connect("Bearer chc_nope")).rejects.toThrow();
  });
});
