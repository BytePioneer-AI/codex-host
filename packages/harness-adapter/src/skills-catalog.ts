import { opendir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Optional Adapter capability for the catalog of the Harness's own local skill directories.
 * Listing and content reads stay read-only; the optional switches go through the Harness's own
 * native mechanisms (its config writer through its interpreter, an archive move on disk), and
 * `uninstall` removes the skill's directory after re-confirming the target on a fresh scan.
 * Read-only roots (the cross-Harness shared directory) refuse writes at the capability level.
 * Mirrors {@link HarnessUsageStatisticsCapability}: the Host discovers it by duck typing on
 * `skillsCatalog`.
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
    ref: HarnessSkillRef,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<HarnessSkillsSetEnabledOutcome>;
  /** Optional: the skill's SKILL.md source for the detail dialog. */
  readContent?(ref: HarnessSkillRef, signal: AbortSignal): Promise<HarnessSkillsContentRead>;
  /**
   * Optional: delete the skill's own directory. Destructive and irreversible — the page asks for
   * confirmation first, and implementations must re-check on a fresh scan that the ref (name plus
   * the confirmed path, when given) still resolves to exactly that directory.
   */
  uninstall?(ref: HarnessSkillRef, signal: AbortSignal): Promise<HarnessSkillsUninstallOutcome>;
}

export interface HarnessSkillsUninstallOutcome {
  ok: boolean;
  /** Absolute directory that was removed. */
  path?: string;
  reason?: string;
}

export interface HarnessSkillsContentRead {
  ok: boolean;
  /** Markdown source; absent when the Harness refused. */
  content?: string;
  /** The manifest ran past the read ceiling and the tail was dropped. */
  truncated?: boolean;
  reason?: string;
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

/**
 * Unambiguous skill identity. The name alone is not unique across categories, archives and the
 * shared root; `path` is the directory the user actually saw and confirmed, so every mutating
 * call carries it and implementations refuse when a fresh scan disagrees.
 */
export interface HarnessSkillRef {
  name: string;
  /** Absolute skill directory the page acted on; optional only for legacy callers. */
  path?: string;
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
/**
 * Directory segments the scanner reports as archived. Hidden-but-loaded conventions like Codex's
 * `.system` deliberately stay out: "archived" is the `.archive` restore convention, not any dot.
 */
export const ARCHIVE_SEGMENT_NAMES = [".archive"];

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
  const lines = rest.slice(0, end.index).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? "";
    let value = pair[2]?.trim() ?? "";
    // Block scalars (`>`, `|` and their chomping variants) fold the indented lines that follow;
    // descriptions written as `description: >-` would otherwise show the marker itself.
    const block = /^([>|])([+-]?\d*|\d+[+-]?)$/u.exec(value);
    if (block) {
      const folded: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const body = lines[next] ?? "";
        if (body.trim() === "" && folded.length === 0) continue;
        if (body.startsWith("  ") || body.startsWith("\t")) folded.push(body.replace(/^\s+/u, ""));
        else break;
      }
      while (folded.length > 0 && folded.at(-1) === "") folded.pop();
      value = folded.join(block[1] === ">" ? " " : "\n");
      index += folded.length;
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!fields.has(key)) fields.set(key, value);
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
  /** Archived is the ARCHIVE convention only; `.system` and friends are loaded normally. */
  const archived =
    inside && relative.split(/[\\/]/u).some((segment) => ARCHIVE_SEGMENT_NAMES.includes(segment));
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
      // path.join, not `${directory}/${entry}`: a literal slash yields mixed separators on Windows
      // (`C:\...\skills/broken-skill`), which no longer matches anything downstream.
      const child = path.join(directory, entry);
      if (visited.has(child)) continue;
      visited.add(child);
      let manifest: string | undefined;
      try {
        manifest = await options.readFile(path.join(child, HARNESS_SKILL_MANIFEST));
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
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  if (typeof home !== "string" || home.length === 0) return undefined;
  return `${home}/.agents/skills`;
}

/** Directories only; files and unreadable entries are skipped by the scanner's contract. */
export async function readDirectories(directory: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      // A skill directory may legitimately be a symlink (dotfiles-style managed skills);
      // opendir reports those as neither file nor directory, so verify them by stat.
      if (entry.isDirectory()) entries.push(entry.name);
      else if (entry.isSymbolicLink())
        try {
          if ((await stat(path.join(directory, entry.name))).isDirectory())
            entries.push(entry.name);
        } catch {
          /* dangling link: skipped like an unreadable entry */
        }
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
