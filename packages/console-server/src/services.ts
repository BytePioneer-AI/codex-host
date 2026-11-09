import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ConsoleInstallation, LaunchCommand } from "./installation.js";

/** Use the native Launcher for service lifecycle, with this Console's resources. */
export function serviceCommand(
  installation: ConsoleInstallation,
  action: "stop" | "web",
): LaunchCommand {
  if (!installation.launcherExecutable) throw new Error("codexhost Launcher was not found");
  const resource = (packaged: string, source: string): string => {
    const bundled = path.join(installation.appDirectory, packaged);
    return existsSync(bundled)
      ? bundled
      : path.resolve(installation.appDirectory, "..", "..", source, "dist", "main.js");
  };
  return {
    command: installation.launcherExecutable,
    args: [
      action,
      "--node",
      process.execPath,
      "--host-runtime",
      resource("host-runtime.mjs", "host-runtime"),
      "--web-runtime",
      resource("web-server.mjs", "web-server"),
    ],
  };
}

export function runServiceCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A stop must survive the Console's own shutdown and stay outside its process tree.
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Launcher exited (${code})`));
    });
  });
}
