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
    const expand = (p?: string): string | undefined => {
      if (!p) return undefined;
      if (p === "~") return home;
      if (p.startsWith("~") && (p[1] === "/" || p[1] === "\\")) return path.join(home, p.slice(2));
      return p;
    };
    return {
      ...profile,
      ...(profile.command ? { command: expand(profile.command) } : {}),
      ...(profile.configDir ? { configDir: expand(profile.configDir) } : {}),
    };
  } catch {
    return undefined;
  }
}
