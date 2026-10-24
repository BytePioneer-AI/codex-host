import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseClaudeCodeProfiles, type ClaudeCodeProfile } from "@codexhost/shared-contracts";

export function defaultClaudeProfilesPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CODEXHOST_CLAUDE_PROFILES_FILE) {
    return path.resolve(environment.CODEXHOST_CLAUDE_PROFILES_FILE);
  }
  const baseDir = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(baseDir, "claude-code-profiles.json");
}

export async function loadClaudeCodeProfile(
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeProfile | undefined> {
  const filePath = defaultClaudeProfilesPath(environment);
  try {
    const raw = await readFile(filePath, "utf8");
    const profiles = parseClaudeCodeProfiles(JSON.parse(raw));
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return undefined;
    const home = environment.HOME || os.homedir();
    const baseDir = path.dirname(filePath);
    const expand = (p?: string): string | undefined => {
      if (!p) return undefined;
      let expanded = p;
      if (p === "~") expanded = home;
      else if (p.startsWith("~/") || p.startsWith("~\\")) expanded = path.join(home, p.slice(2));
      return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
    };
    return {
      ...profile,
      ...(profile.command ? { command: expand(profile.command) } : {}),
      configDir: expand(profile.configDir) ?? profile.configDir,
    };
  } catch {
    return undefined;
  }
}
