import { access, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import {
  createHarnessSkillsCatalog,
  harnessSharedSkillsDirectory,
  harnessSkillFrontmatter,
  type HarnessSkill,
  type HarnessSkillsCatalogCapability,
  type HarnessSkillsSetEnabledOutcome,
  type HarnessSkillsRoot,
} from "@codexhost/harness-adapter";

import { readDisabledSkills, setSkillDisabled } from "./skills-config.js";

const MANIFEST = "SKILL.md";

/** Hermes' own skills root, plus the cross-Harness shared directory Hermes also loads. */
export function hermesSkillsRoots(environment: NodeJS.ProcessEnv): readonly HarnessSkillsRoot[] {
  const root = hermesSkillsRoot(environment);
  const shared = harnessSharedSkillsDirectory(environment);
  return [
    ...(root ? [{ directory: root }] : []),
    ...(shared ? [{ directory: shared, categoryFallback: "shared" }] : []),
  ];
}

function hermesSkillsRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const home = environment["HERMES_HOME"] ?? environment["HOME"];
  if (typeof home !== "string" || home.length === 0) return undefined;
  return `${home}/skills`;
}

/**
 * Hermes' skills with their real on-disk state: `config` skills carry the switch from
 * `config.yaml`, archived ones (`skills/.archive/...`) are off and restorable, and the shared
 * cross-Harness root stays read-only because turning one of its skills off affects every Harness.
 */
export function createHermesSkillsCatalog(
  environment: NodeJS.ProcessEnv,
): HarnessSkillsCatalogCapability {
  const base = createHarnessSkillsCatalog({
    environment,
    roots: hermesSkillsRoots,
    label: "Hermes",
  });
  const shared = harnessSharedSkillsDirectory(environment);

  const read = async (signal: AbortSignal) => {
    const [listing, disabled] = await Promise.all([
      base.list(signal),
      readDisabledSkills(environment),
    ]);
    return {
      skills: (listing.skills ?? []).map((skill) => decorate(skill, disabled, shared)),
      failures: listing.failures ?? [],
    };
  };

  return Object.freeze({
    ...(base.label === undefined ? {} : { label: base.label }),
    list: read,
    readContent: (name: string, signal: AbortSignal) =>
      base.readContent === undefined
        ? Promise.resolve({ ok: false, reason: "Hermes skills are not readable here" })
        : base.readContent(name, signal),
    async setEnabled(
      name: string,
      enabled: boolean,
      signal: AbortSignal,
    ): Promise<HarnessSkillsSetEnabledOutcome> {
      const listing = await read(signal);
      const skill = listing.skills.find((entry) => entry.name === name);
      if (!skill) return { ok: false, reason: `No Hermes skill named ${name}` };
      if (shared && skill.root === shared) {
        return { ok: false, reason: "Shared skills are read-only in this page" };
      }
      if (skill.archived) {
        if (!enabled) return { ok: false, reason: `${name} is already archived` };
        return restoreArchivedSkill(environment, skill);
      }
      const disabled = await setSkillDisabled(environment, name, enabled);
      if (!disabled) return { ok: false, reason: "Hermes config is not writable" };
      return disabled.has(name) === !enabled
        ? { ok: true }
        : { ok: false, reason: `${name} cannot be disabled (essential skill)` };
    },
  });
}

function decorate(
  skill: HarnessSkill,
  disabled: Set<string> | undefined,
  shared: string | undefined,
): HarnessSkill {
  if (shared && skill.root === shared) return skill;
  if (skill.archived) return { ...skill, enabled: false, archived: true, toggle: "archive" };
  if (!disabled) return { ...skill, enabled: true };
  return { ...skill, enabled: !disabled.has(skill.name), toggle: "config" };
}

/** Moves an archived skill back where Hermes loads it: `<category>/<dir>` when it names one. */
async function restoreArchivedSkill(
  environment: NodeJS.ProcessEnv,
  skill: HarnessSkill,
): Promise<HarnessSkillsSetEnabledOutcome> {
  const root = hermesSkillsRoot(environment);
  if (!root) return { ok: false, reason: "HERMES_HOME is not set" };
  const directoryName = path.basename(skill.path);
  const manifest = await readFile(path.join(skill.path, MANIFEST), "utf8").catch(() => "");
  const declared = harnessSkillFrontmatter(manifest)?.["category"]?.trim();
  // The scanner falls back to the parent directory name, so `.archive` must not become a directory.
  const category = declared && !declared.startsWith(".") ? declared : undefined;
  const target = category
    ? path.join(root, category, directoryName)
    : path.join(root, directoryName);
  if (await exists(target)) {
    return { ok: false, reason: `${target} already exists` };
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await rename(skill.path, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
