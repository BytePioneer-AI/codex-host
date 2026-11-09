import assert from "node:assert/strict";
import { it, vi } from "vitest";
import type { IPty } from "node-pty";
import { LocalTerminalHandle } from "../../../apps/web-ui/packages/subprocess/subprocess-local/src/terminal.ts";
import type { ProcessInspector } from "../../../apps/web-ui/packages/subprocess/subprocess-local/src/process-inspector.ts";

it.each(["output", "silent", "exit", "timeout"])(
  "closes a Windows terminal after delayed initialization (%s)",
  async (mode) => {
    let data: (value: string) => void = () => {};
    let exit: (value: { exitCode: number }) => void = () => {};
    let pid = 0;
    let alive = true;
    const signals: number[] = [];
    let fallbackKills = 0;
    const terminal: IPty = {
      get pid() {
        return pid;
      },
      cols: 80,
      rows: 24,
      process: "cmd.exe",
      handleFlowControl: false,
      onData: (listener) => {
        data = listener;
        return { dispose() {} };
      },
      onExit: (listener) => {
        exit = listener;
        return { dispose() {} };
      },
      resize() {},
      clear() {},
      write() {},
      pause() {},
      resume() {},
      kill() {
        fallbackKills++;
        if (mode === "timeout") return;
        throw new Error("Unidentified ConPTY cleanup must not be used");
      },
    };
    const identity = { pid: 42, started: "original" };
    const inspector: ProcessInspector = {
      foregroundPgid: () => pid,
      isStdinWaiting: () => false,
      isAlive: () => alive,
      snapshot: () => ({
        tree: (root) => (root === 42 && alive ? [identity] : []),
        session: () => [],
        alive: () => alive,
      }),
      signalGroup() {
        assert.fail("Expected identity-fenced cleanup");
      },
      signalProcess: (member) => {
        assert.deepEqual(member, identity);
        signals.push(member.pid);
        alive = false;
      },
    };
    const handle = new LocalTerminalHandle(terminal, inspector, 1, "win32");
    if (mode === "timeout") {
      vi.useFakeTimers();
      try {
        const rejected = assert.rejects(handle.terminate(), /Windows terminal startup timed out/);
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        assert.equal(fallbackKills, 1);
        assert.equal(handle.running, true);
        assert.deepEqual(signals, []);
        exit({ exitCode: 0 });
        await handle.terminate();
        assert.deepEqual(await handle.done, { exitCode: 0, signal: null });
      } finally {
        vi.useRealTimers();
      }
      return;
    }
    const closing = handle.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(signals, []);
    if (mode === "exit") {
      exit({ exitCode: 0 });
      await closing;
      assert.deepEqual(signals, []);
      assert.deepEqual(await handle.done, { exitCode: 0, signal: null });
      return;
    }
    pid = 42;
    if (mode === "output") data("ready");
    await closing;
    assert.equal(handle.pid, 42);
    assert.deepEqual(signals, [42]);
    assert.deepEqual(await handle.done, { exitCode: null, signal: null });
    exit({ exitCode: 0 });
    await handle.terminate();
    assert.deepEqual(signals, [42]);
  },
);
