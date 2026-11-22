import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import path from "node:path";

/** Retain a Windows process object before killing its owner; a reused PID is not
 * evidence that the old Harness child survived native tree cleanup. */
export async function watchWindowsProcess(input: {
  pid: number;
  root: string;
  repository: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{ hasExited(): Promise<boolean>; close(): Promise<void> }> {
  const executable = path.join(input.root, "process-watcher.exe");
  await promisify(execFile)(
    "rustc",
    [
      path.join(input.repository, "packages/host-runtime/test/fixtures/shared-host-native-cli.rs"),
      "--edition=2024",
      "-o",
      executable,
    ],
    { timeout: 30_000 },
  );
  const child = spawn(executable, ["--watch-process", String(input.pid)], {
    env: input.environment,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const closed = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const close = async () => {
    child.stdin.end();
    await closed;
    lines.close();
  };
  try {
    assert.equal((await iterator.next()).value, "observing");
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async hasExited() {
      child.stdin.write("check\n");
      const result = await iterator.next();
      assert.ok(!result.done && ["running", "exited"].includes(result.value));
      return result.value === "exited";
    },
    close,
  };
}
