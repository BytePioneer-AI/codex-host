import type { IPty } from "node-pty";
import { expect, it, vi } from "vitest";
import { disposeWindowsPtyTransport } from "@deepseek-ai/dsh-subprocess-local/src/windows-pty-transport.ts";
import { windowsPtyAgent } from "./windows-pty-fixture.ts";

it("releases owned PTY handles without resolving or signalling a recycled shell PID", () => {
  const agent = windowsPtyAgent();
  const terminal = { _agent: agent, kill: vi.fn() };
  disposeWindowsPtyTransport(terminal as unknown as IPty);
  expect(agent._ptyNative.kill).toHaveBeenCalledWith(7, false);
  expect(agent._pendingPtyInfo).toBeUndefined();
  expect(agent._clearConnectionTimeout).toHaveBeenCalledOnce();
  expect(agent._conoutSocketWorker.dispose).toHaveBeenCalledOnce();
  expect(agent._inSocket.destroy).toHaveBeenCalledOnce();
  expect(agent._outSocket.destroy).toHaveBeenCalledOnce();
  expect(agent._getConsoleProcessList).not.toHaveBeenCalled();
  expect(agent.kill).not.toHaveBeenCalled();
  expect(terminal.kill).not.toHaveBeenCalled();
  disposeWindowsPtyTransport(terminal as unknown as IPty);
  expect(agent._ptyNative.kill).toHaveBeenCalledOnce();
});

it("still releases worker and pipes when native handle cleanup fails", () => {
  const agent = windowsPtyAgent(() => {
    throw new Error("native release failed");
  });
  expect(() => disposeWindowsPtyTransport({ _agent: agent } as unknown as IPty)).toThrow(
    "Windows PTY transport cleanup failed",
  );
  expect(agent._conoutSocketWorker.dispose).toHaveBeenCalledOnce();
  expect(agent._inSocket.destroy).toHaveBeenCalledOnce();
  expect(agent._outSocket.destroy).toHaveBeenCalledOnce();
  expect(agent.kill).not.toHaveBeenCalled();
});

it("fails closed before disposal when the pinned backend layout changes", () => {
  const agent = windowsPtyAgent();
  Reflect.deleteProperty(agent, "_inSocket");
  expect(() => disposeWindowsPtyTransport({ _agent: agent } as unknown as IPty)).toThrow(
    "Unsupported node-pty Windows transport layout",
  );
  expect(agent._ptyNative.kill).not.toHaveBeenCalled();
  expect(agent.kill).not.toHaveBeenCalled();
});
