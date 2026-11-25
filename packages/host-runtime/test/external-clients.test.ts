import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { routeDelegationRequest } from "../src/delegation-control-server.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  externalClientDescriptorPath,
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import { ExternalClientRegistry, defaultExternalClientsPath } from "../src/external-clients.js";

/** Every Runtime API method as a spy, so a test can tell whether any of them ran. */
function spyApi(): { api: DelegationControlApi; calls: () => string[] } {
  const called: string[] = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method) =>
        typeof method === "string" && method !== "then"
          ? async () => {
              called.push(method);
              return {};
            }
          : undefined,
    },
  );
  return { api: api as DelegationControlApi, calls: () => [...called] };
}

function outputText(stream: PassThrough): string {
  return (stream.read() as Buffer | null)?.toString("utf8") ?? "";
}

async function cli(arguments_: string[], environment: NodeJS.ProcessEnv) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const code = await runDelegationCli({
    arguments: arguments_,
    environment,
    output,
    diagnosticOutput,
  });
  const text = outputText(code === 0 ? output : diagnosticOutput);
  return { code, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

describe("external clients", () => {
  let dataDirectory: string;
  let environment: NodeJS.ProcessEnv;
  const servers: ExternalClientServer[] = [];

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-clients-"));
    environment = { CODEXHOST_DATA_DIR: dataDirectory };
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("registers a client, shows its token once, and stores only a hash", async () => {
    const added = await cli(["client", "add", "grok-bot"], environment);
    expect(added.code).toBe(0);
    const token = added.body?.token as string;
    expect(token).toMatch(/^chc_/u);
    expect(added.body).toMatchObject({
      name: "grok-bot",
      note: expect.stringContaining("not shown again"),
    });

    const filePath = defaultExternalClientsPath(environment);
    const stored = await readFile(filePath, "utf8");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(token.slice(4));
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const listed = await cli(["client", "list"], environment);
    expect(listed.body).toEqual({
      clients: [{ name: "grok-bot", createdAt: expect.any(String), scope: "dispatch" }],
    });
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });

  it("preserves both independent registrations when writers share the registry", async () => {
    const filePath = defaultExternalClientsPath(environment);
    const first = new ExternalClientRegistry(filePath);
    const second = new ExternalClientRegistry(filePath);

    await Promise.all([first.add("first", "read"), second.add("second", "read")]);

    const names = (await first.list()).map(({ name }) => name).sort();
    expect(names).toEqual(["first", "second"]);
  });

  it("rejects invalid and duplicate names without replacing the token", async () => {
    expect((await cli(["client", "add", "Grok_Bot"], environment)).body).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
    const first = await cli(["client", "add", "bot"], environment);
    const again = await cli(["client", "add", "bot"], environment);
    expect(again.body).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    await expect(registry.authenticate(first.body?.token as string)).resolves.toEqual({
      name: "bot",
      scope: "dispatch",
    });
  });

  it("authenticates tokens and sees a removal made by another process", async () => {
    const filePath = defaultExternalClientsPath(environment);
    const cliRegistry = new ExternalClientRegistry(filePath);
    const runtimeRegistry = new ExternalClientRegistry(filePath);
    const { token } = await cliRegistry.add("script");
    await expect(runtimeRegistry.authenticate(token)).resolves.toEqual({
      name: "script",
      scope: "dispatch",
    });
    await expect(runtimeRegistry.authenticate(`${token}x`)).resolves.toBeUndefined();
    await expect(runtimeRegistry.authenticate(undefined)).resolves.toBeUndefined();

    await cliRegistry.remove("script");
    await expect(runtimeRegistry.authenticate(token)).resolves.toBeUndefined();
    await expect(runtimeRegistry.has("script")).resolves.toBe(false);
    await expect(cliRegistry.remove("script")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("serves the delegation API to a client token and to nothing else", async () => {
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    const { token } = await registry.add("script");
    const listHarnesses = vi.fn(async () => ({ harnesses: [] }));
    const callers: string[] = [];
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      route: (call, route, body) => {
        callers.push(call.client);
        return routeDelegationRequest(
          { api: { listHarnesses } as unknown as DelegationControlApi },
          route,
          body,
        );
      },
      descriptorPath: externalClientDescriptorPath(environment),
    });
    expect(server).toBeDefined();
    if (!server) return;
    servers.push(server);

    const request = (authorization?: string) =>
      fetch(new URL("/v1/harness/list", server.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: "{}",
      });
    const missing = await request();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Client token is missing or invalid" },
    });
    expect((await request("Bearer chc_unknown")).status).toBe(401);
    const ok = await request(`Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ harnesses: [] });
    expect(callers).toEqual(["script"]);
    expect(listHarnesses).toHaveBeenCalledOnce();
  });

  it("gives plain HTTP requests the same defaults as the CLI and accepts harness for harnessId", async () => {
    const api = {
      start: vi.fn<DelegationControlApi["start"]>(async () => ({}) as never),
      read: vi.fn(async () => ({})),
      wait: vi.fn(async () => ({})),
      list: vi.fn(async () => ({})),
    };
    const watch = vi.fn(async () => ({}));
    const route = externalClientRouter({
      api: api as unknown as DelegationControlApi,
      watchApi: { watch, watches: vi.fn() } as never,
    });
    const call = { client: "script", scope: "dispatch" } as Parameters<typeof route>[0];

    await route(call, "/v1/delegate/start", { harness: "pi", cwd: "/work", task: "go" });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ harnessId: "pi" }));
    expect(api.start.mock.calls[0]?.[0]).not.toHaveProperty("harness");
    await expect(
      route(call, "/v1/delegate/start", { cwd: "/work", task: "go" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "harnessId is required",
    });
    await expect(
      route(call, "/v1/delegate/start", { harness: "pi", harnessId: "codex", task: "go" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // A malformed id is refused before any worktree could be created for it.
    await expect(
      route(call, "/v1/delegate/start", { harnessId: null, task: "go", worktree: "fix/x" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "harnessId must be a non-empty string",
    });
    expect(api.start).toHaveBeenCalledTimes(1);

    await route(call, "/v1/thread/read", { threadId: "t" });
    expect(api.read).toHaveBeenCalledWith({ threadId: "t", view: "result" });
    await route(call, "/v1/thread/wait", { threadId: "t" });
    expect(api.wait).toHaveBeenCalledWith({ threadId: "t", view: "result", timeoutMs: 30_000 });
    await route(call, "/v1/thread/watch", { threadId: "t" });
    expect(watch).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t", timeoutMs: 29 * 60_000 }),
    );
    // A missing sort used to reach the Runtime as undefined and surface as INTERNAL_ERROR.
    await route(call, "/v1/thread/list", {});
    expect(api.list).toHaveBeenCalledWith({ limit: 25, sort: "created-desc" });
    await route(call, "/v1/thread/list", { limit: 3, sort: "updated-asc" });
    expect(api.list).toHaveBeenLastCalledWith({ limit: 3, sort: "updated-asc" });
  });

  it("publishes a private descriptor without the token and removes it on close", async () => {
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    const { token } = await registry.add("script");
    const descriptorPath = externalClientDescriptorPath(environment);
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      route: async () => ({}),
      descriptorPath,
    });
    if (!server) throw new Error("listener did not start");
    const text = await readFile(descriptorPath, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      endpoint: server.endpoint,
      pid: process.pid,
    });
    expect(text).not.toContain(token);
    if (process.platform !== "win32") expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    await server.close();
    await expect(stat(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stays off and reports when the port is taken", async () => {
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    const first = await startExternalClientServer({
      port: 0,
      clients: registry,
      route: async () => ({}),
      descriptorPath: path.join(dataDirectory, "first.json"),
    });
    if (!first) throw new Error("listener did not start");
    servers.push(first);
    const diagnose = vi.fn();
    const second = await startExternalClientServer({
      port: Number(new URL(first.endpoint).port),
      clients: registry,
      route: async () => ({}),
      descriptorPath: path.join(dataDirectory, "second.json"),
      diagnose,
    });
    expect(second).toBeUndefined();
    expect(diagnose).toHaveBeenCalledWith(expect.stringContaining("is in use"));
  });

  it("lets the CLI reach the listener with a client token and no Host parameters", async () => {
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    const { token } = await registry.add("script");
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      route: async (call, route) => ({ route, client: call.client }),
      descriptorPath: externalClientDescriptorPath(environment),
    });
    if (!server) throw new Error("listener did not start");
    servers.push(server);

    const result = await cli(["harness", "list"], {
      ...environment,
      CODEXHOST_CLIENT_TOKEN: token,
    });
    expect(result).toEqual({ code: 0, body: { route: "/v1/harness/list", client: "script" } });

    const revoked = await cli(["harness", "list"], {
      ...environment,
      CODEXHOST_CLIENT_TOKEN: "chc_revoked",
    });
    expect(revoked.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("registers, lists and changes a client's scope; older entries count as dispatch", async () => {
    const added = await cli(["client", "add", "reader", "--scope", "read"], environment);
    expect(added.body).toMatchObject({ name: "reader", scope: "read" });
    const token = added.body?.token as string;
    const registry = new ExternalClientRegistry(defaultExternalClientsPath(environment));
    await expect(registry.authenticate(token)).resolves.toEqual({ name: "reader", scope: "read" });

    expect(
      (await cli(["client", "add", "writer", "--scope", "admin"], environment)).body,
    ).toMatchObject({
      error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("--scope") },
    });
    expect((await cli(["client", "set", "reader"], environment)).body).toMatchObject({
      error: { code: "INVALID_ARGUMENT", message: "client set requires --scope" },
    });
    expect(
      (await cli(["client", "set", "missing", "--scope", "read"], environment)).body,
    ).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(
      (await cli(["client", "remove", "reader", "--scope", "read"], environment)).body,
    ).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });

    const set = await cli(["client", "set", "reader", "--scope", "dispatch"], environment);
    expect(set.body).toEqual({ name: "reader", createdAt: expect.any(String), scope: "dispatch" });
    // Same token, new scope.
    await expect(registry.authenticate(token)).resolves.toEqual({
      name: "reader",
      scope: "dispatch",
    });

    // An entry written before scopes existed has no scope field.
    const filePath = defaultExternalClientsPath(environment);
    const file = JSON.parse(await readFile(filePath, "utf8")) as {
      clients: Record<string, unknown>[];
    };
    for (const client of file.clients) delete client.scope;
    await writeFile(filePath, JSON.stringify(file));
    expect((await cli(["client", "list"], environment)).body).toEqual({
      clients: [{ name: "reader", createdAt: expect.any(String), scope: "dispatch" }],
    });
    await expect(new ExternalClientRegistry(filePath).authenticate(token)).resolves.toEqual({
      name: "reader",
      scope: "dispatch",
    });
  });

  it("refuses a read client every route that changes something, before it runs", async () => {
    const { api, calls } = spyApi();
    const watchApi = { watch: vi.fn(async () => ({})), watches: async () => ({}) };
    const route = externalClientRouter({ api, watchApi: watchApi as never });
    const reader = { client: "reader", scope: "read" } as Parameters<typeof route>[0];
    for (const [path_, body] of [
      ["/v1/delegate/start", { harnessId: "pi", cwd: "/work", task: "go" }],
      ["/v1/thread/send", { threadId: "t", input: [{ type: "text", text: "more" }] }],
      ["/v1/thread/answer", { threadId: "t", interactionId: "i", answers: {} }],
      ["/v1/thread/export", { threadId: "t" }],
      ["/v1/thread/cancel", { threadId: "t" }],
      ["/v1/thread/watch", { threadId: "t" }],
      ["/v1/thread/not-yet-invented", {}],
    ] as const)
      await expect(route(reader, path_, { ...body })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: `Client 'reader' has read scope and cannot use ${path_}`,
      });
    expect(calls()).toEqual([]);
    expect(watchApi.watch).not.toHaveBeenCalled();

    for (const [path_, body] of [
      ["/v1/harness/list", {}],
      ["/v1/harness/inspect", { harnessId: "pi" }],
      ["/v1/thread/read", { threadId: "t" }],
      ["/v1/thread/wait", { threadId: "t", timeoutMs: 1 }],
      ["/v1/thread/list", {}],
      ["/v1/thread/watches", {}],
    ] as const)
      await expect(route(reader, path_, { ...body })).resolves.toEqual({});
  });

  it("prefers the Host parameters when both are present", async () => {
    const hostFetch = vi.fn(async () => new Response('{"harnesses":[]}', { status: 200 }));
    const output = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["harness", "list"],
        environment: {
          ...environment,
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
          CODEXHOST_RUNTIME_TOKEN: "host-token",
          CODEXHOST_CLIENT_TOKEN: "chc_client",
        },
        output,
        fetchImpl: hostFetch as unknown as typeof fetch,
      }),
    ).resolves.toBe(0);
    const [url, init] = hostFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:1/v1/harness/list");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer host-token");
  });
});
