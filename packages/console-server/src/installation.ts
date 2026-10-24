import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDistributionMetadata, type DistributionMetadata } from "@codexhost/update-manager";

import { LAUNCHER_EXECUTABLE_ENV } from "./paths.js";

export interface InspectDesktop {
  platform: string;
  version: string;
  build: string;
  installRoot: string;
  /** Optional for compatibility with older launchers using inspect schema v1. */
  packagedCodexCli?: string;
  executableCodexCli?: string;
  codexCliSource?: "command-line" | "environment" | "packaged" | "desktop-managed-cache";
  processIds: number[];
}

export interface InspectDocument {
  schemaVersion: 1;
  launcherVersion: string;
  launcherExecutable: string;
  desktop: InspectDesktop | null;
  desktopError: string | null;
  runtime: { descriptorPath: string | null; running: boolean; launcherPid: number | null };
}

export interface ConsoleInstallation {
  /** Directory holding this console entrypoint (`app/` in a release). */
  appDirectory: string;
  /** Null for a source checkout, which has no distribution metadata. */
  distribution: DistributionMetadata | null;
  launcherExecutable: string | null;
}

export async function readDistribution(appDirectory: string): Promise<DistributionMetadata | null> {
  try {
    return parseDistributionMetadata(
      JSON.parse(await readFile(path.join(appDirectory, "codexhost-distribution.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Launcher beside a release payload: `bin/` for npm, Windows and Linux; `MacOS/` in an app bundle. */
export function installedLauncherCandidates(
  appDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const resourcesRoot = path.dirname(appDirectory);
  const suffix = platform === "win32" ? ".exe" : "";
  const candidates = [path.join(resourcesRoot, "bin", `codexhost${suffix}`)];
  if (platform === "darwin" && path.basename(resourcesRoot) === "Resources") {
    candidates.unshift(path.join(path.dirname(resourcesRoot), "MacOS", "codexhost"));
  }
  return candidates;
}

export function resolveLauncherExecutable(
  appDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (filePath: string) => boolean = existsSync,
): string | null {
  const configured = environment[LAUNCHER_EXECUTABLE_ENV];
  if (configured && path.isAbsolute(configured) && exists(configured)) return configured;
  return installedLauncherCandidates(appDirectory, platform).find(exists) ?? null;
}

export async function resolveInstallation(
  appDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ConsoleInstallation> {
  return {
    appDirectory,
    distribution: await readDistribution(appDirectory),
    launcherExecutable: resolveLauncherExecutable(appDirectory, environment),
  };
}

export function parseInspectDocument(value: unknown): InspectDocument {
  if (typeof value !== "object" || value === null) throw new Error("inspect output is invalid");
  const document = value as Partial<InspectDocument>;
  if (document.schemaVersion !== 1 || typeof document.runtime !== "object" || !document.runtime) {
    throw new Error("inspect output has an unsupported schema");
  }
  return document as InspectDocument;
}

export function inspectInstallation(launcherExecutable: string): Promise<InspectDocument> {
  return new Promise((resolve, reject) => {
    execFile(
      launcherExecutable,
      ["inspect", "--json"],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(parseInspectDocument(JSON.parse(stdout)));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * npm installations must start through the npm wrapper, which supplies the
 * packaged resources to the Launcher; other installations use explicit `launch`
 * rather than the browser-opening no-argument entrypoint. The console is already open.
 */
export function launchCommand(
  installation: ConsoleInstallation,
  environment: NodeJS.ProcessEnv = process.env,
): LaunchCommand | null {
  if (installation.distribution?.distribution === "npm") {
    const node = environment.CODEXHOST_NPM_NODE_PATH;
    const wrapper = environment.CODEXHOST_NPM_LAUNCHER_PATH;
    if (node && wrapper && path.isAbsolute(node) && path.isAbsolute(wrapper)) {
      return { command: node, args: [wrapper] };
    }
    return null;
  }
  return installation.launcherExecutable
    ? { command: installation.launcherExecutable, args: ["launch"] }
    : null;
}
