import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

type SpawnLauncher = (
  command: string,
  arguments_: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "ignore", "ignore"];
    windowsHide: true;
  },
) => ChildProcess;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OPEN_TIMEOUT_MS = 10_000;

export function createLauncherUrlOpener(
  environment: NodeJS.ProcessEnv,
  spawnLauncher: SpawnLauncher = (command, arguments_, options) =>
    spawn(command, arguments_, options),
): ((url: URL) => Promise<void>) | undefined {
  const launcher = environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  if (!launcher || !path.isAbsolute(launcher)) return undefined;
  const launcherEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return normalized !== "CODEX_CLI_PATH" && !normalized.startsWith("CODEXHOST_");
    }),
  );

  return (url) => {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.hash !== ""
    ) {
      return Promise.reject(new Error("Native URL handoff requires a loopback root URL"));
    }

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnLauncher(launcher, ["open-loopback-url"], {
          env: launcherEnvironment,
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        });
      } catch {
        reject(new Error("codexhost native URL opener could not start"));
        return;
      }
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onError = (): void => finish(new Error("codexhost native URL opener failed"));
      const onExit = (code: number | null): void =>
        finish(code === 0 ? undefined : new Error("codexhost native URL opener failed"));
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("codexhost native URL opener timed out"));
      }, OPEN_TIMEOUT_MS);
      child.once("error", onError);
      child.once("exit", onExit);
      if (!child.stdin) {
        child.kill();
        finish(new Error("codexhost native URL opener failed"));
        return;
      }
      child.stdin.once("error", onError);
      child.stdin.end(url.href);
    });
  };
}
