/** Isolated server process shared by browser and packed-distribution checks. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";

/**
 * Start the real entry point on an OS-assigned port with disposable data and workspace directories.
 * @param t - test owner of the child process and its data.
 * @param cwd - server working directory.
 * @param entry - Node arguments preceding server options (source or packed entry).
 * @param args - additional server options.
 * @returns the listening URL.
 */
export async function startServer(
  t: TestContext,
  cwd: string,
  entry: string[],
  args: string[],
): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), "codexhost-web-test-"));
  const child = spawn(
    process.execPath,
    [
      ...entry,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data",
      data,
      "--workspace",
      join(data, "workspace"),
      "--no-auth",
      ...(!args.includes("--session-source") ? ["--session-source", "standalone"] : []),
      ...args,
    ],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      await exited;
      clearTimeout(timeout);
    }
    rmSync(data, { recursive: true, force: true });
  });
  return await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(
      () => reject(new Error(`Server startup timed out: ${output}`)),
      15_000,
    );
    const finish = (): void => {
      clearTimeout(timeout);
      lines.close();
    };
    lines.on("line", (line) => {
      const match = /^codexhost web: (http:\/\/\S+)/u.exec(line);
      if (match !== null) {
        finish();
        resolve(match[1] as string);
      }
    });
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", () => {
      finish();
      reject(new Error(`Server exited before listening: ${output}`));
    });
  });
}
