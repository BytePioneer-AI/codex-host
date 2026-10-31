import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

export function hostRestartMode(options) {
  if (options["restart-host"] && options["keep-host"]) {
    throw new Error("--restart-host and --keep-host are mutually exclusive");
  }
  return options["restart-host"] ? "restart" : options["keep-host"] ? "keep" : undefined;
}

/** A stale or invalid ready record does not own a running Host. */
export async function readRunningHost(data, alive = (pid) => process.kill(pid, 0)) {
  let record;
  try {
    record = JSON.parse(await readFile(`${data}/shared-host-ready.json`, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!Number.isInteger(record?.pid) || record.pid <= 0) return null;
  try {
    alive(record.pid);
  } catch (error) {
    if (error.code !== "EPERM") return null;
  }
  return { runtime: typeof record.runtime === "string" ? record.runtime : "" };
}

async function askRestart(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

/** Decide before stopping either interface; Enter and non-interactive prompts preserve tasks. */
export async function shouldRestartHost({
  running,
  changed,
  mode,
  otherInterfaceRunning,
  otherInterface,
  interactive = process.stdin.isTTY === true,
  ask = askRestart,
  log = console.log,
  warn = console.warn,
}) {
  if (!running) return false;
  if (mode === "restart") return true;
  if (mode !== "keep") {
    if (!changed) return false;
    if (!(await otherInterfaceRunning())) return true;
    if (interactive) {
      const answer = await ask(
        `codexhost dev: Host changed and ${otherInterface} is running. Keep Host or restart Host? [keep/restart] (default: keep): `,
      );
      if (answer.trim().toLowerCase() === "restart") return true;
    } else {
      warn(
        "codexhost dev: Host changed but was not restarted (stdin is not a TTY); use --restart-host to restart it",
      );
    }
  }
  log("codexhost dev: keeping Host; the new interface connects to the old Host");
  return false;
}
