import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  installationVersion,
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  withNodeRuntimeOnPath,
} from "@codexhost/harness-discovery";

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export interface DeepSeekCommandInvocation {
  command: string;
  arguments: string[];
  kind: "configured" | "dsh" | "npx";
}

export function deepSeekEnvironment(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const pathFlavor = platform === "win32" ? path.win32 : path.posix;
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const directory = pathFlavor.dirname(command);
  const directories = (environment[key] ?? "").split(pathFlavor.delimiter).filter(Boolean);
  const equal =
    platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (
    pathFlavor.isAbsolute(command) &&
    !directories.some((entry) => equal(entry) === equal(directory))
  ) {
    directories.unshift(directory);
  }
  return withNodeRuntimeOnPath(
    { ...environment, [key]: directories.join(pathFlavor.delimiter) },
    process.execPath,
    platform,
  );
}

export function deepSeekNpxVersionFile(environment: NodeJS.ProcessEnv): string {
  const dataDirectory =
    environment.CODEXHOST_DATA_DIR ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".codexhost");
  return path.join(dataDirectory, "deepseek-npx-version");
}

function deepSeekNpxSpecifier(environment: NodeJS.ProcessEnv): string {
  try {
    const version = installationVersion(readFileSync(deepSeekNpxVersionFile(environment), "utf8"));
    return `@deepseek-ai/dsh@${version}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "@deepseek-ai/dsh";
  }
}

export function resolveDeepSeekCommand(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): DeepSeekCommandInvocation | null {
  if (configured) {
    const command = resolveHarnessExecutable(
      { id: "deepseek-harness", command: "dsh" },
      { command: configured, environment },
    )?.executable;
    return command ? { command, arguments: [], kind: "configured" } : null;
  }
  const dsh = resolveHarnessExecutable(
    {
      id: "deepseek-harness",
      command: "dsh",
      installRoots: { posix: [VERSION_MANAGER_ROOTS], windows: [VERSION_MANAGER_ROOTS] },
    },
    { environment },
  )?.executable;
  if (dsh) return { command: dsh, arguments: [], kind: "dsh" };
  const npx = resolveHarnessExecutable(
    { id: "deepseek-harness", command: process.platform === "win32" ? "npx.cmd" : "npx" },
    { environment },
  )?.executable;
  return npx
    ? {
        command: npx,
        arguments: ["--offline", "--no-install", deepSeekNpxSpecifier(environment)],
        kind: "npx",
      }
    : null;
}

export function deepSeekProcessInvocation(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: arguments_, windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: environmentValue(environment, "ComSpec") ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function resolveWindowsTaskkillPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot =
    environmentValue(environment, "SystemRoot") ?? environmentValue(environment, "windir");
  if (!systemRoot || !/^[A-Za-z]:[\\/]/u.test(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable or invalid");
  }
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

export function killDeepSeekProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  timeoutMs: number,
): void {
  if (!child.pid) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    const result = spawnSync(
      resolveWindowsTaskkillPath(process.env),
      ["/pid", String(child.pid), "/t", "/f"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: timeoutMs,
      },
    );
    if (result.error) throw result.error;
    if (result.signal) {
      throw new Error(`Windows taskkill terminated with signal ${result.signal}`);
    }
    if (result.status !== 0) {
      throw new Error(`Windows taskkill exited with status ${String(result.status)}`);
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ESRCH") {
      throw error;
    }
  }
}
