import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  identifyStopTarget,
  launcherProcess,
  listUserProcesses,
  stopProcess,
  waitForExit,
} from "./stop-processes.mjs";

export const usage = `usage: npm stop

Stop this user's local codexhost services across worktrees:
  Web previews/watchers, managed Codex Desktop, Hosts and Console.
Running tasks and Web terminals are interrupted. No data or build files are removed.
The invoking worktree does not need to be built. Run from a separate terminal,
not a task hosted by the Host you are stopping. Do not start another interface concurrently.

options:
  --help    show this help without stopping anything`;

/** Stop reconnecting clients first; native supervisors retain ownership of task cleanup. */
export async function stopDevelopment({
  arguments_ = process.argv.slice(2),
  list = listUserProcesses,
  identify = identifyStopTarget,
  stop = stopProcess,
  wait = waitForExit,
  log = console.log,
} = {}) {
  if (arguments_.length === 1 && ["--help", "-h"].includes(arguments_[0])) {
    log(usage);
    return;
  }
  if (arguments_.length) throw new Error("npm stop takes no arguments (use --help for usage)");
  const processes = await list();
  const targets = (await Promise.all(processes.map((candidate) => identify(candidate)))).filter(
    Boolean,
  );
  const supervisors = new Map();
  for (const target of targets) {
    const parent = processes.find((candidate) => candidate.pid === target.parentPid);
    const launcher = launcherProcess(parent);
    // Snapshot payloads need not contain repository metadata or a surviving ready file.
    // Their shared Host must still belong to the native Host supervisor before we stop it.
    if (target.kind === "shared-host" && !launcher?.rest.startsWith("host serve ")) {
      throw new Error(
        `Cannot verify the supervisor of Host PID ${target.pid}; nothing was stopped`,
      );
    }
    if (["desktop", "shared-host"].includes(target.kind) && launcher) {
      supervisors.set(target.pid, parent);
    }
  }
  if (targets.length === 0) {
    log("codexhost stop: no managed local services are running");
    return;
  }
  log(
    "codexhost stop: stopping local services across worktrees; running tasks will be interrupted",
  );
  for (const kind of ["watch", "web", "desktop", "shared-host", "host", "console"]) {
    for (const target of targets.filter((candidate) => candidate.kind === kind)) {
      log(`codexhost stop: stopping ${kind} (PID ${target.pid})`);
      await stop(target, { list });
      const supervisor = supervisors.get(target.pid);
      // Controller exit closes its managed Desktop; Host exit reaps its Harness tree.
      if (supervisor) await wait(supervisor, { list });
    }
  }
  const remaining = (
    await Promise.all((await list()).map((candidate) => identify(candidate)))
  ).filter(Boolean);
  if (remaining.length) {
    throw new Error(
      "Managed services are still running or were started during stop; do not start interfaces concurrently",
    );
  }
  log("codexhost stop: local services stopped; session data and configuration were preserved");
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  stopDevelopment().catch((error) => {
    console.error(`codexhost stop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
