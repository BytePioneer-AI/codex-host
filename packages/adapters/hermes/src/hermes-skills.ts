import { access, mkdir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";

import {
  createHarnessSkillsCatalog,
  harnessSharedSkillsDirectory,
  harnessSkillFrontmatter,
  type HarnessSkill,
  type HarnessSkillRef,
  type HarnessSkillsCatalogCapability,
  type HarnessSkillsSetEnabledOutcome,
  type HarnessSkillsRoot,
} from "@codexhost/harness-adapter";

import { readDisabledSkills, readEssentialSkills, setSkillDisabled } from "./skills-config.js";

const MANIFEST = "SKILL.md";

/** Hermes' own skills root, plus the cross-Harness shared directory Hermes also loads. */
export function hermesSkillsRoots(environment: NodeJS.ProcessEnv): readonly HarnessSkillsRoot[] {
  const root = hermesSkillsRoot(environment);
  const shared = harnessSharedSkillsDirectory(environment);
  return [
    ...(root ? [{ directory: root }] : []),
    ...(shared ? [{ directory: shared, categoryFallback: "shared", readOnly: true }] : []),
  ];
}

function hermesSkillsRoot(environment: NodeJS.ProcessEnv): string | undefined {
  // HERMES_HOME is the Hermes root (~/.hermes) when set; the fallback composes it from HOME —
  // $HOME/skills would scan a directory Hermes never loads.
  const hermesHome = environment["HERMES_HOME"];
  if (typeof hermesHome === "string" && hermesHome.length > 0) return `${hermesHome}/skills`;
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  if (typeof home !== "string" || home.length === 0) return undefined;
  return `${home}/.hermes/skills`;
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

  /** Resolves the exact Hermes skill a ref names; the confirmed path must still match. */
  const resolveRef = async (
    ref: HarnessSkillRef,
    signal: AbortSignal,
  ): Promise<{ skill: HarnessSkill } | { reason: string }> => {
    const listing = await read(signal);
    const byName = listing.skills.filter((entry) => entry.name === ref.name);
    if (byName.length === 0) return { reason: `No Hermes skill named ${ref.name}` };
    if (ref.path === undefined) {
      if (byName.length > 1)
        return { reason: `${ref.name} is ambiguous here; retry from the page` };
      return { skill: byName[0]! };
    }
    const match = byName.find(
      (entry) => path.resolve(entry.path) === path.resolve(ref.path as string),
    );
    return match
      ? { skill: match }
      : { reason: `${ref.name} no longer lives at ${ref.path}; reload the page` };
  };

  return Object.freeze({
    ...(base.label === undefined ? {} : { label: base.label }),
    list: read,
    readContent: (ref: HarnessSkillRef, signal: AbortSignal) =>
      base.readContent === undefined
        ? Promise.resolve({ ok: false, reason: "Hermes skills are not readable here" })
        : base.readContent(ref, signal),
    uninstall: async (ref: HarnessSkillRef, signal: AbortSignal) => {
      const resolved = await resolveRef(ref, signal);
      if ("reason" in resolved) return { ok: false, reason: resolved.reason };
      const skill = resolved.skill;
      if (shared && skill.root === shared) {
        return { ok: false, reason: "Shared skills are read-only in this page" };
      }
      // An unreadable essential list must not read as "nothing is protected": refuse instead.
      const essential = await readEssentialSkills(environment);
      if (essential === undefined) {
        return {
          ok: false,
          reason: `Hermes could not confirm its essential skills; removal of ${ref.name} refused`,
        };
      }
      if (essential.has(skill.name)) {
        return { ok: false, reason: `${skill.name} is an essential Hermes skill` };
      }
      return base.uninstall === undefined
        ? { ok: false, reason: "Hermes skills are not removable here" }
        : base.uninstall(ref, signal);
    },
    async setEnabled(
      ref: HarnessSkillRef,
      enabled: boolean,
      signal: AbortSignal,
    ): Promise<HarnessSkillsSetEnabledOutcome> {
      const resolved = await resolveRef(ref, signal);
      if ("reason" in resolved) return { ok: false, reason: resolved.reason };
      const skill = resolved.skill;
      if (shared && skill.root === shared) {
        return { ok: false, reason: "Shared skills are read-only in this page" };
      }
      if (skill.archived) {
        if (!enabled) return { ok: false, reason: `${skill.name} is already archived` };
        return restoreArchivedSkill(environment, skill);
      }
      const disabled = await setSkillDisabled(environment, skill.name, enabled);
      if (!disabled) return { ok: false, reason: "Hermes config is not writable" };
      return disabled.has(skill.name) === !enabled
        ? { ok: true }
        : { ok: false, reason: `${skill.name} cannot be disabled (essential skill)` };
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
  // The category becomes a real directory segment: ONE legal segment only — no separators, no
  // `..`, no leading dot — and the final target is re-checked to stay inside the skills root.
  const category =
    declared && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(declared) ? declared : undefined;
  const target = category
    ? path.join(root, category, directoryName)
    : path.join(root, directoryName);
  // Compare on ONE resolved basis: realpath of the root (a symlinked HOME, e.g. macOS
  // /var -> /private/var, must not make every legal target look like an escape) with the
  // target re-based onto it through their logical relative path.
  const rootResolved = path.resolve(root);
  const rootReal = await realpath(root).catch(() => rootResolved);
  const targetReal = path.resolve(rootReal, path.relative(rootResolved, path.resolve(target)));
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    return { ok: false, reason: "Restored category escapes the Hermes skills root" };
  }
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
