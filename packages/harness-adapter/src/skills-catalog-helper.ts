import { readFile } from "node:fs/promises";

import {
  readDirectories,
  scanHarnessSkillsRoot,
  type HarnessSkill,
  type HarnessSkillFailure,
  type HarnessSkillsCatalogCapability,
  type HarnessSkillsCatalogRead,
} from "./skills-catalog.js";

/** One skill root the Harness itself loads skills from. */
export interface HarnessSkillsRoot {
  directory: string;
  /** Shown when the root's skills carry neither frontmatter category nor parent directory. */
  categoryFallback?: string | undefined;
}

/**
 * Shared adapter implementation of the skills capability: every root is scanned read-only with
 * the harness-adapter scanner, and the reads are merged in root order. Skill roots are
 * environment-derived, so tests can point the capability at temporary directories.
 */
export function createHarnessSkillsCatalog(options: {
  environment?: NodeJS.ProcessEnv;
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[];
  label: string;
}): HarnessSkillsCatalogCapability {
  const environment = options.environment ?? process.env;
  return Object.freeze({
    label: options.label,
    list: async (signal: AbortSignal): Promise<HarnessSkillsCatalogRead> => {
      const skills: HarnessSkill[] = [];
      const failures: HarnessSkillFailure[] = [];
      const roots = options.roots(environment);
      for (const root of roots) {
        const scan = await scanHarnessSkillsRoot(
          root.directory,
          { readdir: readDirectories, readFile: (file) => readFile(file, "utf8") },
          signal,
        );
        for (const skill of scan.skills) {
          skills.push({
            ...(!skill.category && root.categoryFallback
              ? { ...skill, category: root.categoryFallback }
              : skill),
            root: root.directory,
          });
        }
        failures.push(...scan.failures);
        if (signal.aborted) break;
      }
      return { skills, failures };
    },
  });
}
