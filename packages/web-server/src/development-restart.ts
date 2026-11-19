import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { snapshotPackagedHost } from "./packaged-host.ts";
import type { PreviewOptions } from "./preview-launch.ts";

import {
  hostRestartMode,
  readRunningHost,
  shouldRestartHost,
} from "../../../tools/dev-desktop/host-restart.mjs";
import {
  isDesktopRunning,
  previewProcesses,
  type PreviewProcess,
} from "../../../tools/dev-desktop/interface-processes.mjs";

export { previewProcesses };
export type { PreviewProcess };
const exec = promisify(execFile);

/** Match the exact packed entry and port; never stop a process merely for occupying a port. */
export function isDevelopmentWeb(
  candidate: PreviewProcess,
  entry: string,
  port: string,
  node = process.execPath,
): boolean {
  if (typeof candidate.command !== "string") return false;
  const command =
    process.platform === "win32" ? candidate.command.toLowerCase() : candidate.command;
  const prefixes = [node, `"${node}"`].flatMap((executable) =>
    [entry, `"${entry}"`].map((file) => `${executable} ${file} `),
  );
  return (
    prefixes.some((prefix) =>
      command.startsWith(process.platform === "win32" ? prefix.toLowerCase() : prefix),
    ) && /\s--port\s+(\d+)(?:\s|$)/u.exec(command)?.[1] === port
  );
}

export async function stopDevelopmentWeb(
  entry: string,
  port: string,
  {
    list = previewProcesses,
    signal = (pid: number) => process.kill(pid, "SIGTERM"),
    timeoutMs = 10_000,
  } = {},
): Promise<void> {
  for (const previous of (await list()).filter((candidate) =>
    isDevelopmentWeb(candidate, entry, port),
  )) {
    const stillRunning = async () =>
      (await list()).some(
        (candidate) =>
          candidate.pid === previous.pid &&
          candidate.created === previous.created &&
          candidate.command === previous.command,
      );
    if (!(await stillRunning())) continue;
    try {
      signal(previous.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (await stillRunning()) {
      if (Date.now() >= deadline)
        throw new Error("Previous Web preview did not exit; restart was stopped");
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

/** Called only by an explicit development restart, after the build and preview validation. */
export async function restartDevelopmentPreview(
  distribution: string,
  options: PreviewOptions,
  environment: NodeJS.ProcessEnv,
  {
    snapshot = snapshotPackagedHost,
    stopWeb = stopDevelopmentWeb,
    readHost = readRunningHost,
    desktopRunning = isDesktopRunning,
    decide = shouldRestartHost,
    run = async (command: string, args: string[]) =>
      exec(command, args, { env: environment, timeout: 60_000 }),
  } = {},
): Promise<void> {
  const mode = hostRestartMode(options);
  if (options["ch-cdp"])
    throw new Error("Development restart requires a local shared Host; --ch-cdp is not supported");
  const data = resolve(
    options["ch-data"] ??
      (options["ch-control-directory"]
        ? dirname(resolve(options["ch-control-directory"]))
        : join(homedir(), ".codexhost")),
  );
  const payload = await snapshot(distribution, data);
  const runtime = resolve(options["ch-host-runtime"] ?? join(payload, "app/host-runtime.mjs"));
  const owner = await readHost(data);
  const restart = await decide({
    running: owner !== null,
    changed: owner?.runtime !== runtime,
    mode,
    otherInterfaceRunning: desktopRunning,
    otherInterface: "Codex Desktop",
  });
  await stopWeb(join(distribution, "app/server.mjs"), options.port ?? "4400");
  if (!restart) return;
  console.log("codexhost web: restarting shared Host; running tasks will be interrupted");
  await run(
    resolve(
      options["ch-launcher"] ??
        join(payload, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost"),
    ),
    [
      "host",
      "restart",
      "--node",
      process.execPath,
      "--host-runtime",
      runtime,
      "--data",
      data,
      "--plugins",
      resolve(options["ch-plugins"] ?? join(payload, "adapters")),
      ...(options["ch-codex-home"] ? ["--codex-home", resolve(options["ch-codex-home"])] : []),
    ],
  );
}
