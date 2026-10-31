import { access, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_SKILL_MANIFEST,
  readDirectories,
  scanHarnessSkillsRoot,
  type HarnessSkill,
  type HarnessSkillFailure,
  type HarnessSkillRef,
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
  /**
   * The root serves every Harness at once (the cross-Harness shared directory): writes are
   * refused by the backend, not just hidden by the page — a shared skill that declares another
   * category must still never be removed through here.
   */
  readOnly?: boolean;
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
    readContent: (ref: HarnessSkillRef, signal: AbortSignal) =>
      readSkillContent(environment, options.roots, list, ref, signal),
    uninstall: (ref: HarnessSkillRef, signal: AbortSignal) =>
      uninstallSkill(environment, options.roots, list, ref, signal),
  });
}

/**
 * Resolves the exact skill a ref names. The name alone is not unique (categories, archives and
 * the shared root can all hold same-name skills), so a ref without a path is only honored when
 * it is unambiguous, and a ref with a path must still match the fresh scan.
 */
async function resolveSkill(
  environment: NodeJS.ProcessEnv,
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[],
  list: (signal: AbortSignal) => Promise<HarnessSkillsCatalogRead>,
  ref: HarnessSkillRef,
  signal: AbortSignal,
): Promise<{ skill: HarnessSkill; root: HarnessSkillsRoot } | { reason: string }> {
  const read = await list(signal);
  const byName = (read.skills ?? []).filter((entry) => entry.name === ref.name);
  if (byName.length === 0) return { reason: `No skill named ${ref.name}` };
  if (ref.path === undefined) {
    // Legacy caller without a path: never guess between same-name siblings.
    if (byName.length > 1) return { reason: `${ref.name} is ambiguous here; retry from the page` };
    const only = byName[0];
    if (!only) return { reason: `No skill named ${ref.name}` };
    const root = roots(environment).find((entry) => entry.directory === only.root);
    return root ? { skill: only, root } : { reason: `${ref.name} sits outside every skill root` };
  }
  // The confirmed path must still be what the scan sees — it may have moved or been renamed
  // since the page listed it, or a same-name sibling may sit at the confirmed spot.
  const confirmed = ref.path as string;
  const match = byName.find((entry) => path.resolve(entry.path) === path.resolve(confirmed));
  if (!match) return { reason: `${ref.name} no longer lives at ${ref.path}; reload the page` };
  const root = roots(environment).find((entry) => entry.directory === match.root);
  return root ? { skill: match, root } : { reason: `${ref.name} sits outside every skill root` };
}

async function readSkillContent(
  environment: NodeJS.ProcessEnv,
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[],
  list: (signal: AbortSignal) => Promise<HarnessSkillsCatalogRead>,
  ref: HarnessSkillRef,
  signal: AbortSignal,
): Promise<HarnessSkillsContentRead> {
  const resolved = await resolveSkill(environment, roots, list, ref, signal);
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  const { skill } = resolved;
  // The path comes from the scanner, but a symlinked skill directory could still point outside
  // its root; only read when the RESOLVED directory stays inside one of the roots.
  if (!(await insideAnyRoot(roots(environment), skill.path))) {
    return { ok: false, reason: `${ref.name} sits outside every skill root` };
  }
  try {
    return await readManifestBounded(path.join(skill.path, HARNESS_SKILL_MANIFEST));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads at most MAX_CONTENT_BYTES from disk: the ceiling caps actual I/O, not just the string
 * that survives it, so a runaway file beside a manifest cannot stall the page or the memory.
 */
async function readManifestBounded(file: string): Promise<HarnessSkillsContentRead> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_CONTENT_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_CONTENT_BYTES - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (bytesRead < buffer.length) break;
    }
    const truncated =
      total >= MAX_CONTENT_BYTES && (await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead > 0;
    return { ok: true, content: Buffer.concat(chunks).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

/** Root containment on the real path, so a symlinked skill cannot escape its root. */
async function insideAnyRoot(
  roots: readonly HarnessSkillsRoot[],
  candidate: string,
): Promise<boolean> {
  const real = await realpath(candidate).catch(() => path.resolve(candidate));
  for (const root of roots) {
    const rootReal = await realpath(root.directory).catch(() => path.resolve(root.directory));
    if (real === rootReal || real.startsWith(rootReal + path.sep)) return true;
  }
  return false;
}

/**
 * Deletes one skill directory. Guard rails, because this is the only destructive path in the
 * catalog: the target must match the confirmed ref on a fresh scan, sit inside a writable root,
 * be one or two segments deep (never the root itself), not sit under a hidden/system directory,
 * and still hold a SKILL.md. Anything else is refused with a reason the page can show.
 */
async function uninstallSkill(
  environment: NodeJS.ProcessEnv,
  roots: (environment: NodeJS.ProcessEnv) => readonly HarnessSkillsRoot[],
  list: (signal: AbortSignal) => Promise<HarnessSkillsCatalogRead>,
  ref: HarnessSkillRef,
  signal: AbortSignal,
): Promise<HarnessSkillsUninstallOutcome> {
  const resolved = await resolveSkill(environment, roots, list, ref, signal);
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  const { skill, root } = resolved;
  // Backend-enforced read-only root: the page hiding the button is UX, this is the guarantee.
  if (root.readOnly === true) {
    return { ok: false, reason: `${root.directory} is a read-only shared root` };
  }
  if (!(await insideAnyRoot(roots(environment), skill.path))) {
    return { ok: false, reason: `${ref.name} sits outside every skill root` };
  }
  const segments = path
    .relative(root.directory, skill.path)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > 2) {
    return { ok: false, reason: `${ref.name} is nested too deep to remove safely` };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return { ok: false, reason: `${ref.name} lives in a hidden or system directory` };
  }
  try {
    await access(path.join(skill.path, HARNESS_SKILL_MANIFEST));
  } catch {
    return { ok: false, reason: `${ref.name} is not a skill directory` };
  }
  try {
    await rm(skill.path, { recursive: true });
    return { ok: true, path: skill.path };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
