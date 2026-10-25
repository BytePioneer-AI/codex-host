import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectClaudeCodeProfiles, type ClaudeCodeProfile } from "@codexhost/shared-contracts";

/**
 * Compare directories by real identity so symlinks, `..` aliases and case-insensitive
 * filesystems cannot hide two Harnesses pointing at one store.
 */
export async function configDirectoryIdentity(directory: string): Promise<string> {
  const normalized = path.resolve(directory);
  try {
    const resolved = await realpath(normalized);
    return process.platform === "win32" || process.platform === "darwin"
      ? resolved.toLowerCase()
      : resolved;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const parent = path.dirname(normalized);
      if (parent === normalized) return normalized;
      const resolvedParent = await configDirectoryIdentity(parent);
      const joined = path.join(resolvedParent, path.basename(normalized));
      return process.platform === "win32" || process.platform === "darwin"
        ? joined.toLowerCase()
        : joined;
    }
    return process.platform === "win32" || process.platform === "darwin"
      ? normalized.toLowerCase()
      : normalized;
  }
}

export function defaultClaudeProfilesPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CODEXHOST_CLAUDE_PROFILES_FILE) {
    return path.resolve(environment.CODEXHOST_CLAUDE_PROFILES_FILE);
  }
  const baseDir = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(baseDir, "claude-code-profiles.json");
}

function expandUserPath(inputPath: string, home: string): string {
  if (inputPath === "~") return home;
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Resolves a Profile for construction using the same tolerant parsing and path rules as
 * plugin discovery, so a Profile shown in Desktop can always be loaded.
 */
export async function loadClaudeCodeProfile(
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeProfile | undefined> {
  const filePath = defaultClaudeProfilesPath(environment);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const home = environment.HOME || os.homedir();
  const baseDir = path.dirname(filePath);
  const resolve = (value: string): string => {
    const expanded = expandUserPath(value, home);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
  };

  const seenConfigDirs = new Set<string>();
  const defaultIdentities = new Set<string>();
  defaultIdentities.add(await configDirectoryIdentity(path.join(home, ".claude")));
  if (environment.CLAUDE_CONFIG_DIR) {
    const customLiteral = environment.CLAUDE_CONFIG_DIR;
    const customHome = expandUserPath(customLiteral, home);
    defaultIdentities.add(await configDirectoryIdentity(path.resolve(customHome)));
    defaultIdentities.add(await configDirectoryIdentity(resolve(customLiteral)));
  }

  for (const candidate of collectClaudeCodeProfiles(parsedJson)) {
    const resolvedConfigDir = resolve(candidate.configDir);
    const identity = await configDirectoryIdentity(resolvedConfigDir);
    if (seenConfigDirs.has(identity) || defaultIdentities.has(identity)) continue;
    seenConfigDirs.add(identity);
    if (candidate.id === id) {
      return {
        ...candidate,
        ...(candidate.command ? { command: resolve(candidate.command) } : {}),
        configDir: resolvedConfigDir,
        ...(candidate.icon && !candidate.icon.startsWith("data:")
          ? { icon: resolve(candidate.icon) }
          : {}),
      };
    }
  }
  return undefined;
}
