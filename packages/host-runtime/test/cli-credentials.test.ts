import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cliCredentialsPath, readCliCredentials } from "../src/cli-credentials.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { resolveRuntimeConnection } from "../src/delegation-runtime-connection.js";
import type { DelegationControlApi, DelegationWatchApi } from "../src/delegation-types.js";
import { ClientEventLog } from "../src/external-client-events.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  externalClientDescriptorPath,
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import {
  ExternalClientRegistry,
  defaultExternalClientsPath,
  LOCAL_CLI_CLIENT_NAME,
} from "../src/external-clients.js";

const token = () => `chc_${randomBytes(32).toString("base64url")}`;

async function cli(args: string[], environment: NodeJS.ProcessEnv) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const code = await runDelegationCli({ arguments: args, environment, output, diagnosticOutput });
  const text = (code === 0 ? output : diagnosticOutput).read()?.toString() ?? "";
  return { code, body: text ? JSON.parse(text) : undefined };
}

describe("automatic local CLI credentials", () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  const servers: ExternalClientServer[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-local-cli-"));
    environment = { CODEXHOST_DATA_DIR: directory };
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const cliToken = token();
    const clients = new ExternalClientRegistry(defaultExternalClientsPath(environment), cliToken);
    const api = {
      listHarnesses: vi.fn(async () => ({ harnesses: ["pi"] })),
      start: vi.fn(async (input: Record<string, unknown>) => ({
        threadId: "child",
        parentThreadId: input.parentThreadId,
      })),
      list: vi.fn(async () => ({ threads: [], nextCursor: null })),
    };
    const watchApi = {
      watch: vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "watching" })),
    };
    const events = new ClientEventLog({
      directory: path.join(directory, "events"),
      retentionDays: 7,
    });
    const server = await startExternalClientServer({
      port: 0,
      clients,
      route: externalClientRouter({
        api: api as unknown as DelegationControlApi,
        watchApi: watchApi as unknown as DelegationWatchApi,
        events,
      }),
      descriptorPath: externalClientDescriptorPath(environment),
      cliCredentials: { path: cliCredentialsPath(environment), token: cliToken },
    });
    if (!server) throw new Error("Test listener did not start");
    servers.push(server);
    return { server, clients, cliToken, api, watchApi, events };
  }

  it("lets a credential-free CLI discover the Host without registering a persistent client", async () => {
    const f = await start();
    expect(await cli(["harness", "list"], environment)).toEqual({
      code: 0,
      body: { harnesses: ["pi"] },
    });
    expect(await readCliCredentials(cliCredentialsPath(environment))).toMatchObject({
      endpoint: f.server.endpoint,
      token: f.cliToken,
      pid: process.pid,
    });
    expect(await f.clients.list()).toEqual([]);
    expect(await f.clients.has(LOCAL_CLI_CLIENT_NAME)).toBe(true);
    expect(await readFile(externalClientDescriptorPath(environment), "utf8")).not.toContain(
      f.cliToken,
    );
    if (process.platform !== "win32")
      expect((await stat(cliCredentialsPath(environment))).mode & 0o777).toBe(0o600);
    expect(
      (await fetch(`${f.server.endpoint}/v1/harness/list`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
  });

  it("uses the implicit local client for delegation, watches, workspace listing and events", async () => {
    const f = await start();
    expect(
      (
        await cli(
          ["delegate", "start", "--harness", "pi", "--cwd", directory, "--task", "test"],
          environment,
        )
      ).code,
    ).toBe(0);
    expect(f.api.start).toHaveBeenCalledWith(
      expect.objectContaining({ parentThreadId: "client:local-cli" }),
    );
    expect((await cli(["thread", "watch", "child"], environment)).code).toBe(0);
    expect(f.watchApi.watch).toHaveBeenCalledWith(
      expect.objectContaining({ notifyThreadId: "client:local-cli" }),
    );
    expect((await cli(["thread", "list"], environment)).code).toBe(0);
    expect(f.api.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ cwd: expect.anything() }),
    );
    await f.events.append(LOCAL_CLI_CLIENT_NAME, [
      { type: "watch", threadId: "child", outcome: "completed", deepLink: "codex://threads/child" },
    ]);
    const result = await cli(["events"], environment);
    expect(result.code).toBe(0);
    expect(result.body.events).toHaveLength(1);
    expect(result.body.events[0]).toMatchObject({ threadId: "child", outcome: "completed" });
  });

  it("keeps explicit client and Host credentials ahead of local discovery", async () => {
    const f = await start();
    const registered = await f.clients.add("bot");
    const tokenFile = path.join(directory, "bot-token");
    await writeFile(tokenFile, registered.token, { mode: 0o600 });
    expect(
      await resolveRuntimeConnection({ ...environment, CODEXHOST_CLIENT_TOKEN_FILE: tokenFile }),
    ).toMatchObject({ token: registered.token, kind: "client" });
    expect(
      await resolveRuntimeConnection({ ...environment, CODEXHOST_CLIENT_TOKEN: registered.token }),
    ).toMatchObject({ token: registered.token, kind: "client" });
    expect(
      await resolveRuntimeConnection({
        ...environment,
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
        CODEXHOST_RUNTIME_TOKEN: "internal",
      }),
    ).toEqual({ endpoint: "http://127.0.0.1:1", token: "internal", kind: "host" });
    await expect(
      resolveRuntimeConnection({ ...environment, CODEXHOST_RUNTIME_TOKEN: "partial" }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
    expect(
      (await cli(["harness", "list"], { ...environment, CODEXHOST_CLIENT_TOKEN: "chc_invalid" }))
        .code,
    ).toBe(1);
  });

  it("rotates with the Host, removes credentials on close, and preserves named registrations", async () => {
    const first = await start();
    const registered = await first.clients.add("bot");
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    expect(await readCliCredentials(cliCredentialsPath(environment))).toBeUndefined();
    const missing = await cli(["harness", "list"], environment);
    expect(missing).toMatchObject({ code: 1, body: { error: { code: "RUNTIME_UNREACHABLE" } } });
    const second = await start();
    expect(second.cliToken).not.toBe(first.cliToken);
    expect(await second.clients.authenticate(first.cliToken)).toBeUndefined();
    expect(await second.clients.authenticate(registered.token)).toEqual({
      name: "bot",
      scope: "dispatch",
      networks: ["local"],
    });
    expect((await cli(["harness", "list"], environment)).code).toBe(0);
  });

  it("ignores a credential file left by an exited Host", async () => {
    await start();
    const file = cliCredentialsPath(environment);
    const value = JSON.parse(await readFile(file, "utf8"));
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(exited).toBeGreaterThan(0);
    await writeFile(file, JSON.stringify({ ...value, pid: exited }));
    expect(await readCliCredentials(file)).toBeUndefined();
  });

  it("does not publish CLI credentials when the listener port is occupied", async () => {
    const first = await start();
    const file = path.join(directory, "blocked-credentials.json");
    const result = await startExternalClientServer({
      port: Number(new URL(first.server.endpoint).port),
      clients: new ExternalClientRegistry(defaultExternalClientsPath(environment), token()),
      route: async () => ({}),
      descriptorPath: path.join(directory, "blocked-endpoint.json"),
      cliCredentials: { path: file, token: token() },
    });
    expect(result).toBeUndefined();
    expect(await readCliCredentials(file)).toBeUndefined();
    expect(await readCliCredentials(cliCredentialsPath(environment))).toMatchObject({
      token: first.cliToken,
    });
  });

  it("does not remove credentials published by a newer listener", async () => {
    const first = await start();
    const second = await start();
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    expect(await readCliCredentials(cliCredentialsPath(environment))).toMatchObject({
      token: second.cliToken,
      endpoint: second.server.endpoint,
    });
    expect((await cli(["harness", "list"], environment)).code).toBe(0);
  });

  it("reserves the implicit identity without changing named-client token registration", async () => {
    const f = await start();
    await expect(f.clients.add(LOCAL_CLI_CLIENT_NAME)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const registered = await f.clients.add("bot");
    expect(await f.clients.authenticate(registered.token)).toEqual({
      name: "bot",
      scope: "dispatch",
      networks: ["local"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects readable-by-others credential files and symlinks",
    async () => {
      await start();
      const file = cliCredentialsPath(environment);
      await chmod(file, 0o644);
      await expect(readCliCredentials(file)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await chmod(file, 0o600);
      const linked = path.join(directory, "linked.json");
      await symlink(file, linked);
      await expect(readCliCredentials(linked)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );

  it.each([
    "https://example.com",
    "http://127.0.0.1:80/other",
    "http://user:password@127.0.0.1:4398",
  ])("rejects an unexpected endpoint %s", async (endpoint) => {
    await start();
    const file = cliCredentialsPath(environment);
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, endpoint }));
    await expect(readCliCredentials(file)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
