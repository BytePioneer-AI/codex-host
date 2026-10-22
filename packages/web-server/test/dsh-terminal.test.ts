import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import WebSocket from "ws";

import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

it("serves Session terminals through the DSH terminal controller", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "codexhost-web-terminal-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const pidFile = join(workspace, "shell.pid");
  const host = new FakeChHost();
  host.add("local-thread", workspace, "Local Thread");
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const url = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
      { authenticated: true, environment: { ...process.env, SHELL: "/bin/sh" } },
    ),
  );
  const token = url.searchParams.get("token");
  assert.ok(token);
  const call = async (method: string, args: Record<string, unknown>) => {
    const response = await fetch(new URL(`/api/${method}`, url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: url.origin,
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "terminal",
        method,
        payload: { args },
      }),
    });
    return (await response.json()) as {
      result: { ok: boolean; value?: Record<string, unknown>; error?: { code: string } };
    };
  };

  assert.equal((await call("session/list", {})).result.ok, true);
  const environment = await call("terminal/environment", { agentId: "local-thread" });
  assert.equal(environment.result.ok, true);
  assert.equal(environment.result.value?.cwd, workspace);

  const shells = await call("terminal/shells", { agentId: "local-thread" });
  assert.equal(shells.result.ok, true);
  assert.ok(Array.isArray(shells.result.value) && shells.result.value.length > 0);

  const created = await call("terminal/create", {
    agentId: "local-thread",
    request: { id: "term-1", cols: 80, rows: 24 },
  });
  assert.equal(created.result.ok, true);
  assert.equal(created.result.value?.cwd, workspace);

  const socket = new WebSocket(new URL("/api/remote.mux", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  t.after(() => socket.close());
  await once(socket, "open");
  interface MuxFrame {
    type?: string;
    value?: { type?: string; screen?: string; data?: string };
  }
  const frames: MuxFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as MuxFrame));
  const openFollow = (streamId: string, attachmentId: string): void => {
    socket.send(
      JSON.stringify({
        type: "open",
        streamId,
        endpoint: "terminal/follow",
        payload: { args: { agentId: "local-thread", id: "term-1", attachmentId } },
      }),
    );
  };
  const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("terminal output timed out");
  };
  const screen = (): string =>
    frames
      .filter((frame) => frame.type === "item")
      .map((frame) => {
        const value = frame.value;
        return value?.type === "snapshot" ? (value.screen ?? "") : (value?.data ?? "");
      })
      .join("");

  openFollow("term-stream", "att-1");
  await waitFor(() => frames.some((frame) => frame.type === "item"));

  const written = await call("terminal/write", {
    agentId: "local-thread",
    id: "term-1",
    attachmentId: "att-1",
    data: `pwd; echo $$ > ${pidFile}; echo hello-web-terminal\n`,
  });
  assert.equal(written.result.ok, true);
  await waitFor(() => screen().includes("hello-web-terminal"));
  assert.match(screen(), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const resized = await call("terminal/resize", {
    agentId: "local-thread",
    id: "term-1",
    attachmentId: "att-1",
    cols: 100,
    rows: 30,
  });
  assert.equal(resized.result.ok, true);

  // A second attachment sees the retained screen, as a refreshed page does.
  openFollow("term-stream-2", "att-2");
  await waitFor(() =>
    frames.some(
      (frame) =>
        frame.type === "item" &&
        frame.value?.type === "snapshot" &&
        String(frame.value.screen).includes("hello-web-terminal"),
    ),
  );

  const closed = await call("terminal/close", { agentId: "local-thread", id: "term-1" });
  assert.equal(closed.result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "");
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0));
});
