import type { IPty } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { LocalTerminalHandle } from "@deepseek-ai/dsh-subprocess-local/src/terminal.ts";
import type { ProcessInspector } from "@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts";
import { windowsPtyAgent } from "./windows-pty-fixture.ts";

afterEach(() => vi.useRealTimers());

it.each(["ready", "first-output", "closing", "timeout"])(
  "handles Windows ConPTY PID readiness: %s",
  async (stage) => {
    vi.useFakeTimers();
    const identity = { pid: 4242, started: "original-shell" };
    let alive = true;
    let data: (text: string) => void = () => {};
    const pty = {
      _agent: windowsPtyAgent(),
      pid: stage === "ready" ? identity.pid : 0,
      onData: (listener: typeof data) => {
        data = listener;
        return { dispose() {} };
      },
      onExit: () => ({ dispose() {} }),
      kill: vi.fn(),
    };
    const signalProcess = vi.fn(() => {
      alive = false;
    });
    const tree = vi.fn((pid: number) => (alive && pid === identity.pid ? [identity] : []));
    const inspector: ProcessInspector = {
      snapshot: () => ({ tree, session: () => [], alive: () => alive }),
      isAlive: () => alive,
      signalProcess,
      signalGroup: vi.fn(),
      foregroundPgid: () => pty.pid,
      isStdinWaiting: () => false,
    };
    const handle = new LocalTerminalHandle(pty as unknown as IPty, inspector, 1000, "win32");
    try {
      if (stage === "first-output") {
        pty.pid = identity.pid;
        data("prompt");
      }
      const closing = handle.terminate();
      if (stage === "timeout") {
        const rejected = expect(closing).rejects.toThrow("ConPTY process is not ready");
        await vi.advanceTimersByTimeAsync(5000);
        await rejected;
        expect(signalProcess).not.toHaveBeenCalled();
      } else {
        if (stage === "closing") {
          await vi.advanceTimersByTimeAsync(20);
          expect(signalProcess).not.toHaveBeenCalled();
          pty.pid = identity.pid;
          await vi.advanceTimersByTimeAsync(10);
        }
        await closing;
        expect(handle.pid).toBe(identity.pid);
        expect(signalProcess).toHaveBeenCalledWith(identity, "SIGTERM");
        // Process identity confirms exit even when node-pty has not published onExit.
        await expect(handle.done).resolves.toEqual({ exitCode: null, signal: null });
      }
      // Release PTY transport after verified exit, or queue cancellation on startup timeout.
      expect(pty.kill).not.toHaveBeenCalled();
      expect(pty._agent._ptyNative.kill).toHaveBeenCalledWith(7, false);
      expect(tree).not.toHaveBeenCalledWith(0);
    } finally {
      handle.output.destroy();
    }
  },
);
