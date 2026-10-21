import {
  createHarnessSkillsCatalog,
  harnessSharedSkillsDirectory,
  type HarnessSkillsRoot,
} from "@codexhost/harness-adapter";

/** Claude Code's own skills root, plus the cross-Harness shared directory it also loads. */
export function claudeCodeSkillsRoots(
  environment: NodeJS.ProcessEnv,
): readonly HarnessSkillsRoot[] {
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  if (typeof home !== "string" || home.length === 0) return [];
  const configDir = environment["CLAUDE_CONFIG_DIR"] ?? `${home}/.claude`;
  const shared = harnessSharedSkillsDirectory(environment);
  return [
    { directory: `${configDir}/skills` },
    ...(shared ? [{ directory: shared, categoryFallback: "shared" }] : []),
  ];
}

/** Read-only catalog of Claude Code's local skills; never starts the Claude CLI. */
export function createClaudeCodeSkillsCatalog(
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof createHarnessSkillsCatalog> {
  return createHarnessSkillsCatalog({
    environment,
    roots: claudeCodeSkillsRoots,
    label: "Claude Code",
  });
}
