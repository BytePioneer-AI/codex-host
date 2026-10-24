import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARNESS_PLUGIN_ICON_MAX_BYTES,
  parseClaudeCodeProfiles,
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

  const profiles = parseClaudeCodeProfiles(parsedJson);
  const baseDir = path.dirname(resolvedPath);

  return profiles.map((profile) => ({
    ...profile,
    ...(profile.command ? { command: expandUserPath(profile.command, home) } : {}),
    ...(profile.configDir ? { configDir: expandUserPath(profile.configDir, home) } : {}),
    ...(profile.icon ? { icon: resolveProfileIconPath(profile.icon, baseDir, home) } : {}),
  }));
}

function resolveProfileIconPath(icon: string, baseDir: string, home: string): string {
  if (icon.startsWith("data:")) return icon;
  const expanded = expandUserPath(icon, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

export async function readProfileIcon(iconResource: string): Promise<string> {
  if (iconResource.startsWith("data:")) return iconResource;
  const bytes = await readPluginFile(path.resolve(iconResource), HARNESS_PLUGIN_ICON_MAX_BYTES);
  return encodePluginIconDataUrl(bytes);
}
