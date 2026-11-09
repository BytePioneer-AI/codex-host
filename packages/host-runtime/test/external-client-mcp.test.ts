import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DelegationControlError, type DelegationControlApi } from "../src/delegation-types.js";
import { ClientEventLog } from "../src/external-client-events.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

describe("external client MCP endpoint", () => {
  let directory: string;
  let server: ExternalClientServer | undefined;
  let token: string;
  const api = {
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
    const route = externalClientRouter({ api: api as unknown as DelegationControlApi, events });
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
      "harness_list",
      "harness_inspect",
      "delegate_start",
      "thread_read",
      "thread_wait",
      "thread_list",
      "thread_send",
      "thread_cancel",
      "thread_watch",
      "thread_watches",
      "events_poll",
    ]);
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
        model: { id: "m" },
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
