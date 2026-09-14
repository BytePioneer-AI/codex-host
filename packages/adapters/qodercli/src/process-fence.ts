import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (signal === 0 && (error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export async function closeQoderProcessGroup(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Qoder process tree cannot be confirmed after its Windows root exited");
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root || !path.win32.isAbsolute(root)) throw new Error("Windows SystemRoot is unavailable");
    await executeFile(
      path.win32.join(root, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { timeout: timeoutMs, windowsHide: true },
    );
    return;
  }
  if (!signalGroup(pid, "SIGTERM")) return;
  const gracefulDeadline = Date.now() + timeoutMs;
  while (Date.now() < gracefulDeadline) {
    if (!signalGroup(pid, 0)) return;
    await setTimeout(10);
  }
  if (!signalGroup(pid, "SIGKILL")) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return;
    await setTimeout(10);
  }
  throw new Error("Qoder SDK process group did not exit");
}
