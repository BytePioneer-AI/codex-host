import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import WebSocket from "ws";

import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

it(
  "serves duplex Session terminals through the DSH terminal controller",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-web-terminal-"));
    const home = join(workspace, "home");
    mkdirSync(home);
    const pidFile = join(workspace, "shell.pid");
    const host = new FakeChHost();
    host.add("local-thread", workspace, "Local Thread");
    host.add("invalid-directory", join(workspace, "missing"));
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
        {
          authenticated: true,
          environment: {
            HOME: home,
            USERPROFILE: home,
            ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
          },
        },
      ),
    );
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
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
    const draft = await call("session/create", { request: {} });
    assert.equal(draft.result.ok, true, JSON.stringify(draft));
    const draftId = draft.result.value?.sessionId;
    assert.equal(typeof draftId, "string");
    const draftEnvironment = await call("terminal/environment", { agentId: draftId });
    assert.equal(draftEnvironment.result.ok, true, JSON.stringify(draftEnvironment));
    assert.equal(draftEnvironment.result.value?.cwd, home);
    const homeTerminal = await call("terminal/create", {
      agentId: draftId,
      request: { id: "home-terminal", cols: 80, rows: 24 },
    });
    assert.equal(homeTerminal.result.ok, true, JSON.stringify(homeTerminal));
    assert.equal(homeTerminal.result.value?.cwd, home);
    assert.equal(
      (await call("terminal/close", { agentId: draftId, id: "home-terminal" })).result.ok,
      true,
    );
    assert.equal(
      host.requests.some(({ method }) => method === "thread/start"),
      false,
    );
    // A saved but invalid directory must not silently fall back to home.
    assert.equal(
      (
        await call("terminal/create", {
          agentId: "invalid-directory",
          request: { id: "invalid-terminal", cols: 80, rows: 24 },
        })
      ).result.ok,
      false,
    );
    const environment = await call("terminal/environment", { agentId: "local-thread" });
    assert.equal(environment.result.ok, true, JSON.stringify(environment));
    assert.equal(environment.result.value?.cwd, workspace);
    assert.equal(environment.result.value?.maxInputBytes, 65_536);
    assert.equal(environment.result.value?.maxBufferedBytes, 2_097_152);
    const shells = await call("terminal/shells", { agentId: "local-thread" });
    assert.equal(shells.result.ok, true);
    assert.ok(Array.isArray(shells.result.value) && shells.result.value.length > 0);
    const created = await call("terminal/create", {
      agentId: "local-thread",
      request: { id: "term-1", cols: 160, rows: 24 },
    });
    assert.equal(created.result.ok, true, JSON.stringify(created));
    assert.equal(created.result.value?.cwd, workspace);
    try {
      // Unknown/remote identities cannot acquire a local terminal execution scope.
      assert.equal(
        (
          await call("terminal/create", {
            agentId: "unknown-thread",
            request: { id: "forbidden", cols: 80, rows: 24 },
          })
        ).result.ok,
        false,
      );

      const socket = new WebSocket(new URL("/api/remote.mux", url), {
        headers: { authorization: `Bearer ${token}` },
      });
      t.after(() => socket.close());
      await once(socket, "open");
      interface MuxFrame {
        streamId?: string;
        type?: string;
        error?: { code: string };
        value?: {
          type?: string;
          screen?: string;
          data?: string;
          sequence?: number;
          writable?: boolean;
          refusal?: string;
          info?: { cols: number; rows: number };
          inputWindow?: { maxBytes: number; frameOverheadBytes: number };
        };
      }
      const frames: MuxFrame[] = [];
      socket.on("message", (data) => frames.push(JSON.parse(String(data)) as MuxFrame));
      const send = (frame: object): void => socket.send(JSON.stringify(frame));
      const attach = (streamId: string): void =>
        send({
          type: "open",
          streamId,
          endpoint: "terminal/attach",
          payload: { args: { agentId: "local-thread", id: "term-1" } },
        });
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`terminal frame timed out: ${JSON.stringify(frames)}`);
      };
      const screen = (streamId: string): string =>
        frames
          .filter((frame) => frame.streamId === streamId && frame.type === "item")
          .map(({ value }) =>
            value?.type === "snapshot" ? (value.screen ?? "") : (value?.data ?? ""),
          )
          .join("");
      const snapshot = (streamId: string) =>
        frames.find((frame) => frame.streamId === streamId && frame.value?.type === "snapshot")
          ?.value;
      const ack = (streamId: string, sequence: number) =>
        frames.find(
          (frame) =>
            frame.streamId === streamId &&
            frame.value?.type === "ack" &&
            frame.value.sequence === sequence,
        )?.value;

      attach("first");
      await waitFor(() => snapshot("first") !== undefined);
      assert.equal(snapshot("first")?.writable, true);
      assert.deepEqual(snapshot("first")?.inputWindow, {
        maxBytes: 262_144,
        frameOverheadBytes:
          Buffer.byteLength(JSON.stringify({ type: "item", streamId: "first", value: null })) - 4,
      });
      send({
        type: "item",
        streamId: "first",
        value: {
          type: "write",
          sequence: 1,
          data:
            process.platform === "win32"
              ? `cd & "${join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")}" -NoProfile -Command "(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId | Set-Content -Encoding ascii -LiteralPath '${pidFile.replaceAll("'", "''")}'" & echo hello-web-terminal\r`
              : `pwd; echo $$ > ${pidFile}; printf 'hello-%s\\n' web-terminal\r`,
        },
      });
      await waitFor(
        () => ack("first", 1) !== undefined && screen("first").includes("hello-web-terminal"),
      );
      assert.ok(screen("first").includes(workspace));
      send({
        type: "item",
        streamId: "first",
        value: { type: "resize", sequence: 2, cols: 100, rows: 30 },
      });
      await waitFor(() => ack("first", 2) !== undefined);
      assert.ok(
        frames.some((frame) => frame.value?.info?.cols === 100 && frame.value.info.rows === 30),
      );

      // A fresh attachment restores the same screen and takes control, not the process lifetime.
      attach("second");
      await waitFor(() => snapshot("second") !== undefined);
      assert.ok(snapshot("second")?.screen?.includes("hello-web-terminal"));
      assert.equal(snapshot("second")?.writable, true);
      send({
        type: "item",
        streamId: "first",
        value: { type: "write", sequence: 3, data: "IGNORED" },
      });
      await waitFor(() => ack("first", 3) !== undefined);
      assert.equal(ack("first", 3)?.refusal, "read-only");
      // Half-closing input still allows final acknowledgements and output to drain.
      send({ type: "end", streamId: "first" });
      const command =
        process.platform === "win32"
          ? "chcp 65001 >nul & echo 中文-abcdefghij\r"
          : "printf '中文-%s\\n' abcdefghij\r";
      let sequence = 0;
      for (const character of command)
        send({
          type: "item",
          streamId: "second",
          value: { type: "write", sequence: ++sequence, data: character },
        });
      await waitFor(
        () => ack("second", sequence) !== undefined && screen("first").includes("中文-abcdefghij"),
      );
      assert.ok(!screen("first").includes("IGNORED"));
      assert.ok(!frames.some((frame) => frame.streamId === "first" && frame.type === "end"));

      // Generated upstream codecs reject malformed input on just that logical stream.
      send({
        type: "item",
        streamId: "second",
        value: { type: "write", sequence: ++sequence, data: 42 },
      });
      await waitFor(() =>
        frames.some((frame) => frame.streamId === "second" && frame.type === "error"),
      );
      assert.equal(
        frames.find((frame) => frame.streamId === "second" && frame.type === "error")?.error?.code,
        "gateway/input-invalid",
      );
      attach("recovered");
      await waitFor(() => snapshot("recovered") !== undefined);
      assert.ok(snapshot("recovered")?.screen?.includes("中文-abcdefghij"));
      send({ type: "cancel", streamId: "recovered" });

      const closed = await call("terminal/close", { agentId: "local-thread", id: "term-1" });
      assert.equal(closed.result.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "");
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0));
    } finally {
      await call("terminal/close", { agentId: "local-thread", id: "term-1" });
    }
  },
);
