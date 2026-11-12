import { dirname, join } from "node:path";

export const SKILL_LIBRARY_LIMITS = {
  depth: 6,
  children: 2_000,
  frontmatterBytes: 64 * 1024,
  concurrency: 8,
  workspaces: 32,
  freshMs: 10_000,
  firstScanWaitMs: 1_000,
} as const;

export const SKILL_DIRECTORIES = [
  { source: "Agents", global: [".agents/skills"], project: [".agents/skills"] },
  { source: "Codex", global: [], project: [".codex/skills"], codexHome: true },
  { source: "Claude Code", global: [".claude/skills"], project: [".claude/skills"] },
  { source: "Pi", global: [".pi/agent/skills"], project: [".pi/skills"] },
  {
    source: "OpenCode",
    global: [".config/opencode/skills", ".config/opencode/skill"],
    project: [".opencode/skills", ".opencode/skill"],
  },
  { source: "DeepSeek Harness", global: [], project: [".dsh/skills"] },
] as const;

export const SKIPPED_DIRECTORIES = new Set(["node_modules", "vendor"]);

export interface SkillRoot {
  path: string;
  source: string;
  scope: "project" | "global";
}

export function globalRoots(home: string, codexHome: string): SkillRoot[] {
  return SKILL_DIRECTORIES.flatMap((entry) =>
    ("codexHome" in entry
      ? [join(codexHome, "skills")]
      : entry.global.map((p) => join(home, p))
    ).map((path) => ({ path, source: entry.source, scope: "global" as const })),
  );
}

/** Nearest Git boundary, or just cwd when no ancestor has a Git marker. */
export async function projectRoots(
  cwd: string,
  exists: (path: string) => Promise<boolean>,
): Promise<SkillRoot[]> {
  const ancestors: string[] = [];
  let current = cwd;
  while (true) {
    ancestors.push(current);
    if (await exists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) {
      ancestors.splice(1);
      break;
    }
    current = parent;
  }
  return ancestors.flatMap((ancestor) =>
    SKILL_DIRECTORIES.flatMap((entry) =>
      entry.project.map((path) => ({
        path: join(ancestor, path),
        source: entry.source,
        scope: "project" as const,
      })),
    ),
  );
}
