import { spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function executableCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  const targetPath = process.platform === "win32" ? path.win32 : path.posix;
  if (targetPath.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return [command];
  }
  const extensions =
    process.platform === "win32" && targetPath.extname(command) === ""
      ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];
  return (environmentValue(environment, "PATH") ?? "")
    .split(targetPath.delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) => targetPath.join(directory, command + extension)),
    );
}

export interface DeepSeekCommandInvocation {
  command: string;
  arguments: string[];
  kind: "configured" | "dsh" | "npx";
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of executableCandidates(command, environment)) {
    try {
      accessSync(candidate, accessMode);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through the configured PATH.
    }
  }
  return null;
}

export function resolveDeepSeekCommand(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): DeepSeekCommandInvocation | null {
  if (configured) {
    const command = resolveExecutable(configured, environment);
    return command ? { command, arguments: [], kind: "configured" } : null;
  }
  const dsh = resolveExecutable("dsh", environment);
  if (dsh) return { command: dsh, arguments: [], kind: "dsh" };
  const npx = resolveExecutable(process.platform === "win32" ? "npx.cmd" : "npx", environment);
  return npx
    ? {
        command: npx,
        arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
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
