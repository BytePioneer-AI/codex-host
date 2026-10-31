import {
  createHarnessSkillsCatalog,
  harnessSharedSkillsDirectory,
  type HarnessSkillsRoot,
} from "@codexhost/harness-adapter";

/** Codex's own skills root, plus the cross-Harness shared directory it also loads. */
export function codexSkillsRoots(environment: NodeJS.ProcessEnv): readonly HarnessSkillsRoot[] {
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  if (typeof home !== "string" || home.length === 0) return [];
  const codexHome = environment["CODEX_HOME"] ?? environment["CODE_HOME"] ?? `${home}/.codex`;
  const shared = harnessSharedSkillsDirectory(environment);
  return [
    { directory: `${codexHome}/skills` },
    ...(shared ? [{ directory: shared, categoryFallback: "shared" }] : []),
  ];
}

/** Read-only catalog of Codex's local skills; never starts the Codex CLI. */
export function createCodexSkillsCatalog(
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof createHarnessSkillsCatalog> {
  return createHarnessSkillsCatalog({
    environment,
    roots: codexSkillsRoots,
    label: "Codex",
  });
}
