import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARNESS_PLUGIN_ICON_MAX_BYTES,
  claudeCodeProfileSchema,
  harnessPluginIconSchema,
  type ClaudeCodeProfile,
} from "@codexhost/shared-contracts";

import { encodePluginIconDataUrl, readPluginFile } from "./plugin-files.js";

export const CLAUDE_CODE_PROFILES_FILE_ENV = "CODEXHOST_CLAUDE_PROFILES_FILE";
export const CLAUDE_CODE_PROFILES_FILENAME = "claude-code-profiles.json";

function expandUserPath(inputPath: string, home: string): string {
  if (inputPath === "~") return home;
  if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/")) {
    return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

export function defaultClaudeCodeProfilesPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment[CLAUDE_CODE_PROFILES_FILE_ENV]) {
    return path.resolve(environment[CLAUDE_CODE_PROFILES_FILE_ENV]);
  }
  const baseDir = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(baseDir, CLAUDE_CODE_PROFILES_FILENAME);
}

export async function readClaudeCodeProfiles(
  filePath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeProfile[]> {
  const resolvedPath = filePath
    ? path.resolve(filePath)
    : defaultClaudeCodeProfilesPath(environment);
  const home = environment.HOME || os.homedir();
  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return [];
  }

  let rawList: unknown[];
  if (Array.isArray(parsedJson)) {
    rawList = parsedJson;
  } else if (
    parsedJson &&
    typeof parsedJson === "object" &&
    Array.isArray((parsedJson as Record<string, unknown>).profiles)
  ) {
    rawList = (parsedJson as Record<string, unknown>).profiles as unknown[];
  } else {
    return [];
  }

  const baseDir = path.dirname(resolvedPath);
  const profiles: ClaudeCodeProfile[] = [];
  const seenIds = new Set<string>();
  const seenConfigDirs = new Set<string>();

  for (const item of rawList) {
    const parsed = claudeCodeProfileSchema.safeParse(item);
    if (!parsed.success) continue;
    if (seenIds.has(parsed.data.id)) continue;
    const configDir = resolveProfilePath(parsed.data.configDir, baseDir, home);
    // A shared native store would let two Harnesses resume and write the same Sessions.
    if (seenConfigDirs.has(configDir)) continue;
    seenIds.add(parsed.data.id);
    seenConfigDirs.add(configDir);
    const profile = parsed.data;
    profiles.push({
      ...profile,
      ...(profile.command ? { command: resolveProfilePath(profile.command, baseDir, home) } : {}),
      configDir,
      ...(profile.icon ? { icon: resolveProfileIconPath(profile.icon, baseDir, home) } : {}),
    });
  }

  return profiles;
}

function resolveProfilePath(inputPath: string, baseDir: string, home: string): string {
  const expanded = expandUserPath(inputPath, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function resolveProfileIconPath(icon: string, baseDir: string, home: string): string {
  if (icon.startsWith("data:")) return icon;
  return resolveProfilePath(icon, baseDir, home);
}

export async function readProfileIcon(iconResource: string): Promise<string> {
  if (iconResource.startsWith("data:")) return harnessPluginIconSchema.parse(iconResource);
  const bytes = await readPluginFile(path.resolve(iconResource), HARNESS_PLUGIN_ICON_MAX_BYTES);
  return encodePluginIconDataUrl(bytes);
}
