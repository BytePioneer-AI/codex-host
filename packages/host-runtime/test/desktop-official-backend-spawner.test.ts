import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopSpawnedLoopbackBackend,
  DesktopOfficialSpawnerUnreachableError,
  isDesktopOfficialBackendSpawnerDescriptor,
  startDesktopOfficialBackendSpawner,
} from "../src/codex-runtime/desktop-official-backend-spawner.js";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

function writeLoopbackFixtureScript(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "codexhost-spawner-fixture-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "fixture-backend.mjs");
  const wsUrl = import.meta.resolve("ws");
  writeFileSync(
    script,
    `
import { createHash } from "node:crypto";
import { WebSocketServer } from ${JSON.stringify(wsUrl)};

const args = process.argv.slice(2);
const tokenIdx = args.indexOf("--ws-token-sha256");
const expectedHash = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined;
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket, request) => {
  const auth = request.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const actualHash = createHash("sha256").update(token).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) {
    socket.close(1008, "unauthorized");
    return;
  }
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.id === undefined) return;
    socket.send(
      JSON.stringify({ id: message.id, result: { pid: process.pid, ppid: process.ppid } }),
    );
  });
});
server.on("listening", () => {
  const address = server.address();
  process.stderr.write(\`listening on: ws://127.0.0.1:\${address.port}\\n\`);
});
process.on("SIGTERM", () => {
  for (const client of server.clients) client.terminate();
  server.close(() => process.exit(0));
});
`,
  );
  return script;
}

function sendJsonRpc(
  connection: Awaited<
    ReturnType<ReturnType<typeof createDesktopSpawnedLoopbackBackend>["connect"]>
  >,
  method: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      connection.stdout.off("data", onData);
      const parsed = JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, unknown> };
      resolve(parsed.result ?? {});
    };
    connection.stdout.on("data", onData);
    connection.stdout.once("error", reject);
    connection.stdin.write(`${JSON.stringify({ id: 1, method, params: {} })}\n`);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnFixtureWith(script: string): typeof spawn {
  return ((_command: string, args: readonly string[], opts: SpawnOptions): ChildProcess =>
    spawn(process.execPath, [script, ...args], opts)) as unknown as typeof spawn;
}

describe("desktop official backend spawner", () => {
  it("validates spawner descriptors strictly", () => {
    expect(isDesktopOfficialBackendSpawnerDescriptor({ port: 4321, token: "abc" })).toBe(true);
    expect(isDesktopOfficialBackendSpawnerDescriptor(null)).toBe(false);
    expect(isDesktopOfficialBackendSpawnerDescriptor([])).toBe(false);
    expect(isDesktopOfficialBackendSpawnerDescriptor({ port: 0, token: "abc" })).toBe(false);
    expect(isDesktopOfficialBackendSpawnerDescriptor({ port: 65_536, token: "abc" })).toBe(false);
    expect(isDesktopOfficialBackendSpawnerDescriptor({ port: 4321.5, token: "abc" })).toBe(false);
    expect(isDesktopOfficialBackendSpawnerDescriptor({ port: 4321, token: "" })).toBe(false);
    expect(
      isDesktopOfficialBackendSpawnerDescriptor({ port: 4321, token: "abc", extra: true }),
    ).toBe(false);
  });

  it("spawns an authenticated loopback backend under the Desktop spawner and stops it cleanly", async () => {
    const script = writeLoopbackFixtureScript();
    const spawner = await startDesktopOfficialBackendSpawner({
      spawnOfficial: spawnFixtureWith(script),
    });
    cleanup.push(() => spawner.detach());

    const backend = createDesktopSpawnedLoopbackBackend({
      spawner: spawner.descriptor,
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      environment: {},
    });
    cleanup.push(() => backend.stop().catch(() => undefined));

    await backend.start();
    const pid = backend.processId;
    expect(pid).toBeTypeOf("number");
    if (pid === undefined) throw new Error("Missing processId");
    cleanup.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    });

    const connection = await backend.connect();
    try {
      const result = await sendJsonRpc(connection, "initialize");
      expect(result).toEqual({ pid, ppid: process.pid });
    } finally {
      connection.close();
    }

    await backend.stop();
    await expect(backend.closed).resolves.toMatchObject({ code: 0, signal: null });
    expect(isPidAlive(pid)).toBe(false);
  });

  it("keeps the backend alive across bridge detach and stops it later by PID", async () => {
    const script = writeLoopbackFixtureScript();
    const spawner = await startDesktopOfficialBackendSpawner({
      spawnOfficial: spawnFixtureWith(script),
    });
    cleanup.push(() => spawner.detach());

    const backend = createDesktopSpawnedLoopbackBackend({
      spawner: spawner.descriptor,
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      environment: {},
    });
    cleanup.push(() => backend.stop().catch(() => undefined));

    await backend.start();
    const pid = backend.processId;
    if (pid === undefined) throw new Error("Missing processId");
    cleanup.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    });

    const connection = await backend.connect();
    cleanup.push(() => connection.close());

    await spawner.detach();
    expect(isPidAlive(pid)).toBe(true);
    await expect(sendJsonRpc(connection, "account/read")).resolves.toEqual({
      pid,
      ppid: process.pid,
    });

    connection.close();
    await backend.stop();
    await expect(backend.closed).resolves.toMatchObject({ signal: "SIGTERM" });
    await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false));
  });

  it("reports unreachable errors when starting against a detached spawner", async () => {
    const spawner = await startDesktopOfficialBackendSpawner();
    await spawner.detach();

    const backend = createDesktopSpawnedLoopbackBackend({
      spawner: spawner.descriptor,
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      environment: {},
    });
    await expect(backend.start()).rejects.toBeInstanceOf(DesktopOfficialSpawnerUnreachableError);
  });
});
