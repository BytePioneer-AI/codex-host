import { opendir } from "node:fs/promises";
import path from "node:path";

/**
 * Optional Adapter capability for a read-only catalog of the Harness's own local skill
 * directories. It never starts a native process, opens a Session, or writes native storage; the
 * Host only displays what it returns. Mirrors {@link HarnessUsageStatisticsCapability}: the Host
 * discovers it by duck typing on `skillsCatalog`.
 */
export interface HarnessSkillsCatalogCapability {
  /** Stable display name of the source, shown as-is in the UI (adapter-localized). */
  readonly label?: string;
  /** Every skill the Harness's own skill roots currently hold, plus what could not be read. */
  list(signal: AbortSignal): Promise<HarnessSkillsCatalogRead>;
  /**
   * Optional switch: turn one skill on or off the Harness's own way (a config flip, a restore from
   * an archive directory, …). Capabilities that omit it are read-only and the page shows no switch.
   */
  setEnabled?(
    name: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<HarnessSkillsSetEnabledOutcome>;
}

export interface HarnessSkillsSetEnabledOutcome {
  ok: boolean;
  /** Why the Harness refused; the page shows it next to the switch. */
  reason?: string;
}

export interface HarnessSkillsCatalogRead {
  skills: readonly HarnessSkill[];
  /** Directories that could not be read; the Host shows them instead of hiding the source. */
  failures?: readonly HarnessSkillFailure[];
}

export interface HarnessSkill {
  /** Skill name: frontmatter `name`, else the directory name. */
  name: string;
  description: string;
  /** Category from the frontmatter `category`, else the parent directory name. */
  category?: string;
  /** Absolute directory the SKILL.md lives in. */
  path: string;
  /** Inside a hidden/archive directory (`.archive`, `.system`, …): not loaded by the Harness. */
  archived?: boolean;
  /** Whether the Harness loads this skill now; absent when the Harness exposes no state. */
  enabled?: boolean;
  /** The switch the page may offer: `config` flips it in place, `archive` restores it. */
  toggle?: "config" | "archive";
  /** The skill root this entry came from; adapter-internal, never sent to the page. */
  root?: string;
}

export interface HarnessSkillFailure {
  path: string;
  message: string;
}

/** Shared-skill conventions: a manifest file relative to the skill directory. */
export const HARNESS_SKILL_MANIFEST = "SKILL.md";
/** Frontmatter keys the catalog reads; everything else in the manifest is ignored. */
export const HARNESS_SKILL_CATEGORY_KEY = "category";

const MAX_NAME_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;
/** Manifest bytes read for the frontmatter; a manifest's frontmatter never approaches this. */
const MAX_MANIFEST_PREFIX_BYTES = 64 * 1024;
const SKILLS_PER_ROOT_LIMIT = 4096;

/** Single-line bounded display text, or undefined when nothing remains. */
export function harnessSkillText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  if (characters.length <= maxLength) return normalized;
  return `${characters
    .slice(0, maxLength - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Minimal frontmatter reader: the YAML subset skill manifests actually use — one `key: value`
 * pair per line inside the leading `---` fence. Values may be double- or single-quoted. Deliberately
 * not a YAML parser; a manifest it cannot read yields a failure entry, never a wrong skill.
 */
export function harnessSkillFrontmatter(
  prefix: string,
): Readonly<Record<string, string>> | undefined {
  const fence = /^---(?:\r?\n|$)/u.exec(prefix);
  if (!fence) return undefined;
  const rest = prefix.slice(fence[0].length);
  const end = /^---/mu.exec(rest);
  if (!end) return undefined;
  const fields = new Map<string, string>();
  for (const line of rest.slice(0, end.index).split(/\r?\n/u)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!pair) continue;
    let value = pair[2]?.trim() ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!fields.has(pair[1] ?? "")) fields.set(pair[1] ?? "", value);
  }
  return Object.fromEntries(fields);
}

/** A directory that holds a readable skill manifest; the name defaults to the directory name. */
export function harnessSkillFromDirectory(
  root: string,
  directory: string,
  manifest: string,
): HarnessSkill | undefined {
  // Parse only the leading frontmatter window: real SKILL.md files run past 100 kB and the fence
  // always sits at the top. Truncate the body instead of rejecting the skill.
  const prefix =
    manifest.length > MAX_MANIFEST_PREFIX_BYTES
      ? manifest.slice(0, MAX_MANIFEST_PREFIX_BYTES)
      : manifest;
  const fields = harnessSkillFrontmatter(prefix);
  if (!fields) return undefined;
  const directoryName = harnessSkillText(directory.split(/[\\/]/u).at(-1), MAX_NAME_LENGTH);
  const name = harnessSkillText(fields["name"], MAX_NAME_LENGTH) ?? directoryName;
  const description = harnessSkillText(fields["description"], MAX_DESCRIPTION_LENGTH);
  if (!name || !description) return undefined;
  const relative = path.relative(root, directory);
  const inside = relative !== "" && !relative.startsWith("..");
  const parent = inside ? path.dirname(relative) : "";
  /** A hidden segment (`.archive`, `.system`, …) means the Harness does not load this skill. */
  const archived =
    inside &&
    relative.split(/[\\/]/u).some((segment) => segment.startsWith(".") && segment !== ".");
  const category =
    harnessSkillText(fields[HARNESS_SKILL_CATEGORY_KEY], MAX_NAME_LENGTH) ??
    harnessSkillText(
      parent !== "." && parent !== "" ? parent.split("/").at(-1) : undefined,
      MAX_NAME_LENGTH,
    ) ??
    undefined;
  if (directory.length === 0 || directory.length > MAX_PATH_LENGTH) return undefined;
  return {
    name,
    description,
    ...(category ? { category } : {}),
    path: directory,
    ...(archived ? { archived: true } : {}),
  };
}

export interface HarnessSkillsRootScan {
  skills: HarnessSkill[];
  failures: HarnessSkillFailure[];
}

/**
 * Reads one skill root: nested category directories and flat root directories both, bounded.
 * A skill directory inside a skill directory is skipped (the outer manifest wins).
 */
export async function scanHarnessSkillsRoot(
  root: string,
  options: {
    readdir: (path: string) => Promise<readonly string[]>;
    readFile: (path: string) => Promise<string>;
  },
  signal: AbortSignal,
): Promise<HarnessSkillsRootScan> {
  const skills: HarnessSkill[] = [];
  const failures: HarnessSkillFailure[] = [];
  const visited = new Set<string>([root]);

  const readDirectory = async (directory: string): Promise<void> => {
    if (signal.aborted || skills.length >= SKILLS_PER_ROOT_LIMIT) return;
    let entries: readonly string[];
    try {
      entries = await options.readdir(directory);
    } catch (error) {
      if (directory !== root) {
        failures.push({ path: directory, message: errorMessage(error) });
      }
      return;
    }
    for (const entry of entries) {
      if (signal.aborted || skills.length >= SKILLS_PER_ROOT_LIMIT) return;
      const child = `${directory}/${entry}`;
      if (visited.has(child)) continue;
      visited.add(child);
      let manifest: string | undefined;
      try {
        manifest = await options.readFile(`${child}/${HARNESS_SKILL_MANIFEST}`);
      } catch {
        manifest = undefined;
      }
      if (manifest !== undefined) {
        const skill = harnessSkillFromDirectory(root, child, manifest);
        if (skill) skills.push(skill);
        else
          failures.push({
            path: child,
            message: `${HARNESS_SKILL_MANIFEST} has no readable name and description`,
          });
        continue;
      }
      await readDirectory(child);
    }
  };

  await readDirectory(root);
  return { skills, failures };
}

/** The Host's cross-Harness shared skills directory: the shared root the adapters also use. */
export function harnessSharedSkillsDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const home = environment["HOME"];
  if (typeof home !== "string" || home.length === 0) return undefined;
  return `${home}/.agents/skills`;
}

/** Directories only; files and unreadable entries are skipped by the scanner's contract. */
export async function readDirectories(directory: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (entry.isDirectory()) entries.push(entry.name);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return entries.sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return harnessSkillText(text, 512) ?? "unreadable";
}
