import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cursorInvocation } from "./command.js";
import type { CursorTransportOptions } from "./transport.js";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Drive native commands in an isolated store. Never forward terminal output to Host. */
export async function runCursorForkTerminal(
  options: CursorTransportOptions,
  sessionId: string,
  signal: AbortSignal,
  rewind?: { steps: number; complete: () => boolean },
): Promise<void> {
  signal.throwIfAborted();
  const invocation = cursorInvocation(options.environment, options.command, [
    "--trust",
    "--resume",
    sessionId,
  ]);
  // script inherits a 0x0 terminal from a headless Host. Set the actual PTY size,
  // not just COLUMNS/LINES, before Cursor computes its interactive layout.
  const command = [
    "/bin/sh",
    "-c",
    'stty rows 40 cols 140 && exec "$@"',
    "cursor-fork-pty",
    invocation.command,
    ...invocation.arguments,
  ];
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...command]
      : ["-q", "-f", "-c", command.map(quote).join(" "), "/dev/null"];
  // BSD script rejects Node's socketpair stdin. cat supplies a real Unix pipe;
  // argv stays positional so command paths and arguments never become shell code.
  const child = spawn("/bin/sh", ["-c", 'cat | /usr/bin/script "$@"', "cursor-fork", ...args], {
    cwd: options.cwd,
    env: { ...options.environment, TERM: "xterm-256color", COLUMNS: "140", LINES: "40" },
    stdio: "pipe",
    detached: true,
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  let tail = "";
  let failure: Error | undefined;
  child.once("error", () => {
    failure = new Error("Cursor fork terminal could not start");
  });
  child.once("exit", () => {
    failure = new Error("Cursor fork terminal exited before completion");
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    tail = (tail + data).slice(-64_000);
  });
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const plain = () => tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  const waitFor = async (ready: () => boolean) => {
    for (;;) {
      if (signal.aborted) throw new Error("Cursor fork cancelled");
      if (failure) throw failure;
      if (Date.now() >= deadline) throw new Error("Cursor native fork/rewind timed out");
      if (ready()) return;
      await delay(50);
    }
  };
  const send = (text: string) => {
    tail = "";
    child.stdin.write(text);
  };
  const submitCommand = async (name: string, description: string) => {
    send(name);
    await waitFor(() => plain().includes(description));
    // Only Enter after native command discovery, never submit a command as a prompt.
    send("\r");
  };
  try {
    await waitFor(() => plain().includes("Add a follow-up"));
    await submitCommand("/fork", "Fork the current chat into a new session");
    await waitFor(() => {
      if (
        plain().includes("Failed to fork the conversation:") ||
        plain().includes("Nothing to fork yet.")
      )
        throw new Error("Cursor rejected the native fork");
      return plain().includes("This conversation has been forked.");
    });
    if (rewind) {
      await submitCommand("/rewind", "Jump back to a previous message");
      await waitFor(() => plain().includes("Pick a past turn to rewind to."));
      // The native list starts at (current). Each key must be a separate input event.
      for (let i = 0; i < rewind.steps; i++) {
        send("\x1b[A");
        await waitFor(() => plain().includes("Enter for details"));
      }
      send("\r");
      await waitFor(() => /[12]\. Restore conversation/u.test(plain()));
      if (plain().includes("2. Restore conversation")) {
        send("\x1b[B");
        await waitFor(() => /[→❯›>]\s*2\. Restore conversation/u.test(plain()));
      } else if (!plain().includes("1. Restore conversation")) {
        throw new Error("Cursor did not expose conversation-only restore");
      }
      send("\r");
      // Native rewind has no reliable success toast. Verify the persisted root instead.
      await waitFor(rewind.complete);
    }
  } finally {
    child.stdin.destroy();
    if (child.pid) {
      // script and its PTY child belong exclusively to this operation.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
}
