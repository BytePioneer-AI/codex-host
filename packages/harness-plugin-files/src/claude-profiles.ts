import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARNESS_PLUGIN_ICON_MAX_BYTES,
  collectClaudeCodeProfiles,
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

  const baseDir = path.dirname(resolvedPath);
  const profiles: ClaudeCodeProfile[] = [];
  const seenConfigDirs = new Set<string>();
  // Profiles must never share the default instance's store: Session imports and pending
  // Sessions are keyed by Harness, so a shared root would let two Harnesses claim them.
  // Both ~/.claude and any custom CLAUDE_CONFIG_DIR the default instance uses are protected.
  const defaultIdentities = new Set<string>();
  defaultIdentities.add(await configDirectoryIdentity(path.join(home, ".claude")));
  if (environment.CLAUDE_CONFIG_DIR) {
    const customDefault = resolveProfilePath(environment.CLAUDE_CONFIG_DIR, baseDir, home);
    defaultIdentities.add(await configDirectoryIdentity(customDefault));
  }

  for (const profile of collectClaudeCodeProfiles(parsedJson)) {
    const configDir = resolveProfilePath(profile.configDir, baseDir, home);
    const identity = await configDirectoryIdentity(configDir);
    if (seenConfigDirs.has(identity) || defaultIdentities.has(identity)) continue;
    seenConfigDirs.add(identity);
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
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

/**
 * Resolve directory to realpath through existing ancestors when the target directory
 * does not exist yet. Prevents symlinked parent directories (like /tmp -> /private/tmp)
 * from evading duplicate store detection.
 */
async function realpathWithAncestors(directory: string): Promise<string> {
  const normalized = path.resolve(directory);
  try {
    return await realpath(normalized);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const parent = path.dirname(normalized);
      if (parent === normalized) return normalized;
      const resolvedParent = await realpathWithAncestors(parent);
      return path.join(resolvedParent, path.basename(normalized));
    }
    return normalized;
  }
}

/**
 * Compare directories by real identity so symlinks, `..` aliases and case-insensitive
 * filesystems cannot hide two Harnesses pointing at one store.
 */
async function configDirectoryIdentity(directory: string): Promise<string> {
  const identifier = await realpathWithAncestors(directory);
  return process.platform === "win32" || process.platform === "darwin"
    ? identifier.toLowerCase()
    : identifier;
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
