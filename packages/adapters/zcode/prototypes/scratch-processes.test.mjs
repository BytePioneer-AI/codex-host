import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupScratchProcesses } from "./scratch-processes.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
describe.skipIf(process.platform !== "darwin")("offline native probe cleanup", () => {
  it("finds detached descendants even after their parent exits, without killing another workspace", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "probe-cleanup-")));
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd: os.tmpdir(),
      stdio: "ignore",
    });
    let orphan;
    try {
      const parent = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        console.log(child.pid); child.unref();
      `,
        ],
        { cwd: root, detached: true, stdio: ["ignore", "pipe", "inherit"] },
      );
      let output = "";
      parent.stdout.on("data", (data) => {
        output += data;
      });
      await once(parent, "exit");
      orphan = Number(output.trim());
      expect(Number.isInteger(orphan) && orphan > 1 && alive(orphan)).toBe(true);
      await cleanupScratchProcesses(root, parent.pid);
      await expect.poll(() => alive(orphan)).toBe(false);
      expect(alive(other.pid)).toBe(true);
      await cleanupScratchProcesses(root, parent.pid); // idempotent
    } finally {
      if (orphan && alive(orphan)) process.kill(orphan, "SIGKILL");
      other.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
