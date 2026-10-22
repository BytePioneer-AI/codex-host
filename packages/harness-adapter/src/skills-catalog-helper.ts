import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_SKILL_MANIFEST,
  readDirectories,
  scanHarnessSkillsRoot,
  type HarnessSkill,
  type HarnessSkillFailure,
  type HarnessSkillsCatalogCapability,
  type HarnessSkillsCatalogRead,
  type HarnessSkillsContentRead,
  type HarnessSkillsUninstallOutcome,
} from "./skills-catalog.js";

/** One skill root the Harness itself loads skills from. */
export interface HarnessSkillsRoot {
  directory: string;
  /** Shown when the root's skills carry neither frontmatter category nor parent directory. */
  categoryFallback?: string | undefined;
}

/** Detail views stop here: skill bodies run long, and the dialog is not a viewer for megabytes. */
const MAX_CONTENT_BYTES = 256 * 1024;

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
  const list = async (signal: AbortSignal): Promise<HarnessSkillsCatalogRead> => {
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
  };

  return Object.freeze({
    label: options.label,
    list,
    readContent: (name: string, signal: AbortSignal) =>
      readSkillContent(environment, options.roots, list, name, signal),
    uninstall: (name: string, signal: AbortSignal) =>
      uninstallSkill(environment, options.roots, list, name, signal),
  });
}

async function readSkillContent(
  environment: NodeJS.ProcessEnv,
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[],
  list: (signal: AbortSignal) => Promise<HarnessSkillsCatalogRead>,
  name: string,
  signal: AbortSignal,
): Promise<HarnessSkillsContentRead> {
  const read = await list(signal);
  const skill = (read.skills ?? []).find((entry) => entry.name === name);
  if (!skill) return { ok: false, reason: `No skill named ${name}` };
  // The path comes from the scanner, but a symlinked skill directory could still point outside
  // its root; only read when the resolved directory stays inside one of the roots.
  if (!roots(environment).some((root) => isInside(root.directory, skill.path))) {
    return { ok: false, reason: `${name} sits outside every skill root` };
  }
  try {
    const text = await readFile(path.join(skill.path, HARNESS_SKILL_MANIFEST), "utf8");
    return text.length > MAX_CONTENT_BYTES
      ? { ok: true, content: text.slice(0, MAX_CONTENT_BYTES), truncated: true }
      : { ok: true, content: text, truncated: false };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isInside(root: string, candidate: string): boolean {
  const parent = path.resolve(root) + path.sep;
  return path.resolve(candidate).startsWith(parent);
}

/**
 * Deletes one skill directory. Guard rails, because this is the only destructive path in the
 * catalog: the target must come from the scanner, sit inside a declared root, be one or two
 * segments deep (never the root itself), not sit under a hidden/system directory, and still hold
 * a SKILL.md. Anything else is refused with a reason the page can show.
 */
async function uninstallSkill(
  environment: NodeJS.ProcessEnv,
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[],
  list: (signal: AbortSignal) => Promise<HarnessSkillsCatalogRead>,
  name: string,
  signal: AbortSignal,
): Promise<HarnessSkillsUninstallOutcome> {
  const read = await list(signal);
  const skill = (read.skills ?? []).find((entry) => entry.name === name);
  if (!skill) return { ok: false, reason: `No skill named ${name}` };
  const root = roots(environment).find((entry) => isInside(entry.directory, skill.path));
  if (!root) return { ok: false, reason: `${name} sits outside every skill root` };
  const segments = path
    .relative(root.directory, skill.path)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > 2) {
    return { ok: false, reason: `${name} is nested too deep to remove safely` };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return { ok: false, reason: `${name} lives in a hidden or system directory` };
  }
  try {
    await access(path.join(skill.path, HARNESS_SKILL_MANIFEST));
  } catch {
    return { ok: false, reason: `${name} is not a skill directory` };
  }
  try {
    await rm(skill.path, { recursive: true });
    return { ok: true, path: skill.path };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
