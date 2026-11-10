import { vi } from "vitest";

export function windowsPtyAgent(closeHandle: () => void = () => {}) {
  return {
    _pty: 7,
    _innerPid: 4242,
    _useConptyDll: false,
    _pendingPtyInfo: {} as unknown,
    _clearConnectionTimeout: vi.fn(),
    _ptyNative: { kill: vi.fn(closeHandle) },
    _conoutSocketWorker: { dispose: vi.fn() },
    _inSocket: { destroy: vi.fn() },
    _outSocket: { destroy: vi.fn() },
    _getConsoleProcessList: vi.fn(() => {
      throw new Error("Must not enumerate PIDs");
    }),
    kill: vi.fn(() => {
      throw new Error("Must not signal PIDs");
    }),
  };
}
