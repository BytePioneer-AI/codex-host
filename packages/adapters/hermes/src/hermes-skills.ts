import {
  createHarnessSkillsCatalog,
  harnessSharedSkillsDirectory,
  type HarnessSkillsRoot,
} from "@codexhost/harness-adapter";

/** Hermes' own skills root, plus the cross-Harness shared directory Hermes also loads. */
export function hermesSkillsRoots(environment: NodeJS.ProcessEnv): readonly HarnessSkillsRoot[] {
  const home = environment["HERMES_HOME"] ?? environment["HOME"];
  if (typeof home !== "string" || home.length === 0) return [];
  const shared = harnessSharedSkillsDirectory(environment);
  return [
    { directory: `${home}/skills` },
    ...(shared ? [{ directory: shared, categoryFallback: "shared" }] : []),
  ];
}

/** Read-only catalog of Hermes' local skills; never starts the Hermes CLI. */
export function createHermesSkillsCatalog(
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof createHarnessSkillsCatalog> {
  return createHarnessSkillsCatalog({
    environment,
    roots: hermesSkillsRoots,
    label: "Hermes",
  });
}
