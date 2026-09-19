// Offline probe ownership boundary, never used to manage the user's Desktop.
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execute = promisify(execFile);
async function cwdProcesses(args) {
  let output;
  try {
    output = (
      await execute("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", ...args], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (error.code !== 1) throw error;
    output = error.stdout;
  }
  const entries = [];
  let pid;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)
      entries.push({ pid, cwd: line.slice(1) });
  }
  return entries;
}
export async function cleanupScratchProcesses(root) {
  root = await realpath(root); // Must run BEFORE removing the ownership evidence.
  const owned = (entry) => entry.cwd === root || entry.cwd.startsWith(`${root}/`);
  let quiet = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const entries = (await cwdProcesses(["+D", root])).filter(owned);
    if (!entries.length) {
      if (++quiet === 2) return;
    } else quiet = 0;
    for (const entry of entries) {
      // Re-check immediately before signalling; never act on just a stale PID or app name.
      if (!(await cwdProcesses(["-p", String(entry.pid)])).some(owned)) continue;
      try {
        process.kill(entry.pid, attempt < 3 ? "SIGTERM" : "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await sleep(50);
  }
  throw new Error("Scratch runtime cleanup unconfirmed; directory retained for ownership checks");
}
