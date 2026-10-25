import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectClaudeCodeProfiles, type ClaudeCodeProfile } from "@codexhost/shared-contracts";

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
  const profile = collectClaudeCodeProfiles(parsedJson).find((candidate) => candidate.id === id);
  if (!profile) return undefined;

  const home = environment.HOME || os.homedir();
  const baseDir = path.dirname(filePath);
  const resolve = (value: string): string => {
    const expanded = expandUserPath(value, home);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
  };
  return {
    ...profile,
    ...(profile.command ? { command: resolve(profile.command) } : {}),
    configDir: resolve(profile.configDir),
    ...(profile.icon && !profile.icon.startsWith("data:") ? { icon: resolve(profile.icon) } : {}),
  };
}
