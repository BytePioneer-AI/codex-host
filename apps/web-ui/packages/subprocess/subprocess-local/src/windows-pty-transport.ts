/** Handle-owned transport disposal for the pinned node-pty 1.2.0-beta.15 backend. */
import type { IPty } from "node-pty";

type Resource = Record<string, unknown>;
const closedHandles = new WeakSet<IPty>();

function resource(value: unknown): Resource {
  if (typeof value !== "object" || value === null)
    throw new Error("Unsupported node-pty Windows transport layout");
  return value as Resource;
}

function method(owner: Resource, key: string): (...args: unknown[]) => unknown {
  const value = owner[key];
  if (typeof value !== "function")
    throw new Error(`Unsupported node-pty Windows transport method: ${key}`);
  return (...args) => Reflect.apply(value, owner, args);
}

/**
 * Close the owned pseudoconsole handle, worker and pipes without a PID lookup.
 * IPty has no public transport-only disposal API. Keep this guarded compatibility
 * seam isolated: WindowsTerminal.kill()/destroy() enumerate console PIDs and can
 * signal a recycled shell PID later. The native kill entry closes the stored
 * pseudoconsole/HANDLE, not a process selected by its current numeric PID.
 */
export function disposeWindowsPtyTransport(terminal: IPty): void {
  const agent = resource(Reflect.get(terminal, "_agent"));
  const native = resource(agent._ptyNative);
  const worker = resource(agent._conoutSocketWorker);
  const input = resource(agent._inSocket);
  const output = resource(agent._outSocket);
  const clearConnectionTimeout = method(agent, "_clearConnectionTimeout");
  const closeHandle = method(native, "kill");
  const disposeWorker = method(worker, "dispose");
  const destroyInput = method(input, "destroy");
  const destroyOutput = method(output, "destroy");
  if (typeof agent._pty !== "number" || typeof agent._useConptyDll !== "boolean")
    throw new Error("Unsupported node-pty Windows transport handle");

  clearConnectionTimeout();
  agent._pendingPtyInfo = undefined;
  // Attempt every resource even when a previous release fails; never fall back
  // to IPty.kill(), since its asynchronous PID-based signalling is unsafe here.
  const errors: unknown[] = [];
  for (const release of [
    () => {
      if (closedHandles.has(terminal)) return;
      closeHandle(agent._pty, agent._useConptyDll);
      closedHandles.add(terminal);
    },
    disposeWorker,
    destroyInput,
    destroyOutput,
  ]) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Windows PTY transport cleanup failed");
}
