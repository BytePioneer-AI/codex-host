/**
 * Resolve the local Codex CLI exactly like any other external Harness.
 *
 * Discovery uses the shared Harness rules plus the persisted launch setting, and the
 * child environment drops Desktop routing. A codexhost proxy or shim is refused.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const CODEX_DISCOVERY_SPEC: HarnessDiscoverySpec = {
  id: "codex-cli",
  command: "codex",
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
  },
};

export type CodexExecutable =
  { status: "ready"; command: string } | { status: "notInstalled" } | { status: "unavailable" };

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Desktop ships its own entrypoint; executing it would route through the GUI. */
function isDesktopProxy(command: string, environment: NodeJS.ProcessEnv): boolean {
  const canonicalCommand = canonical(command);
  const proxyName = /codexhost|(?:^|[-_.])shim(?:[-_.]|$)/iu;
  if ([command, canonicalCommand].some((path) => proxyName.test(basename(path)))) return true;
  const routed = environment.CODEX_CLI_PATH;
  return typeof routed === "string" && routed !== "" && canonical(routed) === canonicalCommand;
}

export function resolveCodexExecutable(input: {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}): CodexExecutable {
  const environment = input.environment ?? process.env;
  const resolution = resolveHarnessExecutable(CODEX_DISCOVERY_SPEC, {
    ...(input.command ? { command: input.command } : {}),
    environment,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform: input.platform ?? process.platform,
  });
  if (!resolution) return { status: "notInstalled" };
  const command = resolve(resolution.executable);
  if (isDesktopProxy(command, environment)) return { status: "unavailable" };
  return { status: "ready", command };
}

/** `CODEX_HOME` when configured, otherwise the user's own native home. */
export function codexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(environment.HOME ?? homedir(), ".codex");
}

/**
 * Remove Desktop routing, Desktop identity and Node injection from the native child process.
 * `CODEX_INTERNAL_*` (notably the originator override) would make Web sessions look like
 * Codex Desktop sessions in the user's native history.
 */
export function codexChildEnvironment(
  environment: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const child = Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !name.startsWith("CODEXHOST_") &&
        !name.startsWith("CODEX_INTERNAL_") &&
        !["CODEX_CLI_PATH", "CODEX_THREAD_ID", "NODE_OPTIONS", "NODE_PATH"].includes(name)
      );
    }),
  );
  child.CODEX_HOME = home;
  return child;
}
