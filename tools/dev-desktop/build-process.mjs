/** Own only the subprocess tree created for one development build. */
import { spawn, spawnSync } from "node:child_process";

const OUTPUT_DRAIN_MS = 500;
const TERMINATE_GRACE_MS = 1000;

export function runBuildProcess(
  invocation,
  { root, environment, spawnImplementation = spawn, onStdout, onStderr, signalSource = process },
) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      // Isolate build descendants from the terminal's group. Signals below are
      // forwarded to this group only, never to another codexhost instance.
      detached: process.platform !== "win32",
      windowsHide: false,
    });
    let settled = false;
    let cancelled;
    let exitResult;
    let drainTimer;
    let killTimer;

    const signalTree = (signal) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // taskkill identifies a tree by its live root; never target a PID after
        // that root exited, since Windows may already have reused the PID.
        if (child.exitCode !== null || child.signalCode !== null) return;
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 2000,
        });
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          // macOS can report EPERM for a group containing only zombies.
          if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      signalSource.off("SIGINT", onInterrupt);
      signalSource.off("SIGTERM", onTerminate);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(cancelled ? { code: null, signal: cancelled } : result);
    };
    const forceFinish = () => {
      signalTree("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: exitResult?.code || 1, signal: exitResult?.signal ?? null });
    };
    const cancel = (signal) => {
      if (settled) return;
      if (cancelled) {
        forceFinish();
        return;
      }
      cancelled = signal;
      clearTimeout(drainTimer);
      signalTree(signal);
      killTimer = setTimeout(forceFinish, TERMINATE_GRACE_MS);
    };
    const onInterrupt = () => cancel("SIGINT");
    const onTerminate = () => cancel("SIGTERM");
    signalSource.on("SIGINT", onInterrupt);
    signalSource.on("SIGTERM", onTerminate);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      if (settled || cancelled) return;
      drainTimer = setTimeout(() => {
        onStderr("\nBuild output remained open after process exit; stopping build descendants.\n");
        signalTree("SIGTERM");
        killTimer = setTimeout(forceFinish, TERMINATE_GRACE_MS);
      }, OUTPUT_DRAIN_MS);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      // A POSIX group remains addressable while its descendants survive.
      // Windows cancellation uses taskkill while the root is still alive.
      signalTree("SIGKILL");
      finish({ code, signal });
    });
  });
}
