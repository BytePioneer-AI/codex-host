import { constants as fsConstants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

const FRONTMATTER_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 4;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_ENTRIES = 256;
const MAX_TOTAL_CONFIG_FILES = 64;
const MAX_TOTAL_ROOTS = 256;
const MAX_CHILDREN_PER_DIR = 2_000;
const MAX_TOTAL_DIRS = 4_000;
const MAX_TOTAL_ENTRIES = 16_000;
const MAX_CONCURRENCY = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "vendor"]);
const WORKSPACE_CUSTOMIZATION_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;
const OPEN_NONBLOCK_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/** Normalized non-empty skill descriptions indexed by skill name. */
export type DiscoveredAntigravitySkills = ReadonlyMap<string, ReadonlySet<string>>;

interface DiscoveryBudget {
  configFiles: number;
  entries: number;
  maxEntries: number;
  roots: number;
}

export function normalizeSkillDescription(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Parse `name` and `description` from a SKILL.md YAML frontmatter block using
 * the standard `yaml` parser. Returns `null` when frontmatter is missing,
 * truncated, invalid YAML, or lacks a non-empty `name` or `description` so
 * ambiguous files never cause false-positive command exclusions.
 */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) return null;
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length > 0) return null;
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as { name?: unknown; description?: unknown };
  if (typeof data.name !== "string" || typeof data.description !== "string") return null;
  const name = data.name.trim().replace(/^\//u, "");
  const description = normalizeSkillDescription(data.description);
  if (!name || !description) return null;
  return { name, description };
}

function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

type IoRunner = <T>(operation: () => Promise<T>) => Promise<T>;

/** Atomically reserve a slot in the shared root budget before adding a new root. */
function addRootWithBudget(
  target: Set<string>,
  candidate: string,
  budget: DiscoveryBudget,
): boolean {
  if (target.has(candidate)) return true;
  if (budget.roots >= MAX_TOTAL_ROOTS) return false;
  budget.roots++;
  target.add(candidate);
  return true;
}

async function isDirectory(target: string, io: IoRunner): Promise<boolean> {
  try {
    return (await io(() => stat(target))).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(target: string, io: IoRunner): Promise<boolean> {
  try {
    await io(() => stat(target));
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely read up to `maxBytes` from a regular file without blocking on POSIX
 * FIFOs or special device files: pre-check with `stat()`, open with
 * `O_NONBLOCK`, then re-verify `handle.stat().isFile()` against TOCTOU swaps.
 */
async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  options: { rejectOversized?: boolean },
  io: IoRunner,
): Promise<string | null> {
  try {
    const preStat = await io(() => stat(filePath));
    if (!preStat.isFile()) return null;
    if (options.rejectOversized && preStat.size > maxBytes) return null;
    return await io(async () => {
      const handle = await open(filePath, OPEN_NONBLOCK_FLAGS);
      try {
        const fdStat = await handle.stat();
        if (!fdStat.isFile()) return null;
        if (options.rejectOversized && fdStat.size > maxBytes) return null;
        const readLimit = options.rejectOversized ? maxBytes + 1 : maxBytes;
        const buffer = Buffer.alloc(readLimit);
        let total = 0;
        while (total < readLimit) {
          const { bytesRead } = await handle.read(buffer, total, readLimit - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (options.rejectOversized && total > maxBytes) return null;
        return buffer.subarray(0, total).toString("utf8");
      } finally {
        await handle.close();
      }
    });
  } catch {
    return null;
  }
}

/**
 * Stream directory entries with `opendir()` and stop immediately once either
 * the per-directory width limit or the shared total entry budget is reached.
 */
async function readBoundedDirectoryEntries(
  directory: string,
  budget: DiscoveryBudget,
  io: IoRunner,
  skipNames?: ReadonlySet<string>,
): Promise<Array<{ name: string; isSymbolicLink: boolean }>> {
  if (budget.entries >= budget.maxEntries) return [];
  return io(async () => {
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return [];
    }
    const candidates: Array<{ name: string; isSymbolicLink: boolean }> = [];
    let seenInDir = 0;
    try {
      while (seenInDir < MAX_CHILDREN_PER_DIR && budget.entries < budget.maxEntries) {
        const entry = await handle.read();
        if (!entry) break;
        seenInDir++;
        budget.entries++;
        if (entry.name.startsWith(".") || skipNames?.has(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        candidates.push({ name: entry.name, isSymbolicLink: entry.isSymbolicLink() });
      }
    } catch {
      // Return already collected valid entries on partial directory read errors.
    } finally {
      await handle.close().catch(() => undefined);
    }
    return candidates;
  });
}

async function workspaceAncestors(cwd: string, io: IoRunner): Promise<string[]> {
  const resolved = path.resolve(cwd);
  const ancestors: string[] = [];
  let current = resolved;
  while (true) {
    ancestors.push(current);
    if (await pathExists(path.join(current, ".git"), io)) break;
    const parent = path.dirname(current);
    if (parent === current) {
      ancestors.splice(1);
      break;
    }
    current = parent;
  }
  return ancestors;
}

function resolveConfiguredPath(
  configured: string,
  baseDir: string,
  repoRoot: string,
  home: string,
): string {
  if (configured.startsWith("~/") || configured === "~") {
    return path.join(home, configured.slice(1));
  }
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(baseDir, configured) || path.resolve(repoRoot, configured);
}

interface JsonConfigFile {
  entries?: Array<{ path?: unknown }>;
  inherits?: Array<{ path?: unknown }>;
}

async function collectConfiguredRoots(
  configPath: string,
  repoRoot: string,
  home: string,
  kind: "skills" | "plugins",
  visitedConfigs: Set<string>,
  skillRoots: Set<string>,
  pluginRoots: Set<string>,
  budget: DiscoveryBudget,
  io: IoRunner,
  depth = 0,
): Promise<void> {
  if (
    depth >= MAX_CONFIG_DEPTH ||
    budget.configFiles >= MAX_TOTAL_CONFIG_FILES ||
    budget.roots >= MAX_TOTAL_ROOTS
  ) {
    return;
  }
  let canonical: string;
  try {
    canonical = await io(() => realpath(configPath));
  } catch {
    return;
  }
  if (visitedConfigs.has(canonical) || budget.configFiles >= MAX_TOTAL_CONFIG_FILES) return;
  visitedConfigs.add(canonical);
  budget.configFiles++;
  const content = await readBoundedRegularFile(
    canonical,
    MAX_CONFIG_BYTES,
    { rejectOversized: true },
    io,
  );
  if (content === null) return;
  let parsed: JsonConfigFile;
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    parsed = raw as JsonConfigFile;
  } catch {
    return;
  }
  const baseDir = path.dirname(path.dirname(canonical));
  const resolveTarget = async (rawPath: string): Promise<string> => {
    const primary = resolveConfiguredPath(rawPath, baseDir, repoRoot, home);
    if (await pathExists(primary, io)) return primary;
    if (!path.isAbsolute(rawPath) && !rawPath.startsWith("~")) {
      const fallback = path.resolve(repoRoot, rawPath);
      if (await pathExists(fallback, io)) return fallback;
    }
    return primary;
  };
  const inherits = Array.isArray(parsed.inherits)
    ? parsed.inherits.slice(0, MAX_CONFIG_ENTRIES)
    : [];
  for (const inherited of inherits) {
    if (budget.configFiles >= MAX_TOTAL_CONFIG_FILES || budget.roots >= MAX_TOTAL_ROOTS) break;
    if (typeof inherited?.path !== "string" || !inherited.path.trim()) continue;
    const target = await resolveTarget(inherited.path.trim());
    await collectConfiguredRoots(
      target,
      repoRoot,
      home,
      kind,
      visitedConfigs,
      skillRoots,
      pluginRoots,
      budget,
      io,
      depth + 1,
    );
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, MAX_CONFIG_ENTRIES) : [];
  for (const entry of entries) {
    if (budget.roots >= MAX_TOTAL_ROOTS) break;
    if (typeof entry?.path !== "string" || !entry.path.trim()) continue;
    const target = await resolveTarget(entry.path.trim());
    addRootWithBudget(kind === "skills" ? skillRoots : pluginRoots, target, budget);
  }
}

async function scanSkillRoot(
  root: string,
  visitedDirs: Set<string>,
  skills: Map<string, Set<string>>,
  budget: DiscoveryBudget,
  io: IoRunner,
): Promise<void> {
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (visitedDirs.size >= MAX_TOTAL_DIRS) return;
    let resolved: string;
    try {
      resolved = await io(() => realpath(directory));
    } catch {
      return;
    }
    if (visitedDirs.has(resolved) || visitedDirs.size >= MAX_TOTAL_DIRS) return;
    visitedDirs.add(resolved);
    if (depth > 0) {
      const skillFile = path.join(resolved, "SKILL.md");
      const prefix = await readBoundedRegularFile(
        skillFile,
        FRONTMATTER_BYTES,
        { rejectOversized: false },
        io,
      );
      if (prefix !== null) {
        const frontmatter = parseSkillFrontmatter(prefix);
        if (frontmatter) {
          let descriptions = skills.get(frontmatter.name);
          if (!descriptions) {
            descriptions = new Set();
            skills.set(frontmatter.name, descriptions);
          }
          descriptions.add(frontmatter.description);
        }
        return;
      }
    }
    // Entry budget only stops enumerating further directory entries; candidates
    // already enumerated still have their SKILL.md inspected above.
    if (depth >= MAX_SCAN_DEPTH || budget.entries >= budget.maxEntries) return;
    const candidates = await readBoundedDirectoryEntries(resolved, budget, io, SKIPPED_DIRECTORIES);
    await Promise.all(
      candidates.map(async (entry) => {
        if (visitedDirs.size >= MAX_TOTAL_DIRS) return;
        const child = path.join(resolved, entry.name);
        if (entry.isSymbolicLink && !(await isDirectory(child, io))) return;
        await visit(child, depth + 1);
      }),
    );
  };
  await visit(root, 0);
}

async function collectPluginSkillRoots(
  pluginRoot: string,
  extraSkillRoots: Set<string>,
  budget: DiscoveryBudget,
  io: IoRunner,
): Promise<void> {
  if (budget.entries >= budget.maxEntries || budget.roots >= MAX_TOTAL_ROOTS) return;
  const candidates = await readBoundedDirectoryEntries(pluginRoot, budget, io);
  await Promise.all(
    candidates.map(async (entry) => {
      if (budget.roots >= MAX_TOTAL_ROOTS) return;
      const skillsDir = path.join(pluginRoot, entry.name, "skills");
      if (!(await isDirectory(skillsDir, io))) return;
      addRootWithBudget(extraSkillRoots, skillsDir, budget);
    }),
  );
}

/**
 * Discover skills from Antigravity's workspace, global, plugin, and built-in
 * skill locations so ACP `available_commands_update` entries that come from
 * SKILL.md files can be excluded from native slash commands without dropping
 * genuine native commands that share a name.
 *
 * Standard known skill directories are scanned first so a large plugin tree
 * cannot exhaust the shared budget and starve `.agents/skills`.
 */
export async function discoverAntigravitySkills(options: {
  cwd: string;
  home: string;
  maxEntries?: number;
}): Promise<DiscoveredAntigravitySkills> {
  const io = createConcurrencyLimiter(MAX_CONCURRENCY);
  const budget: DiscoveryBudget = {
    configFiles: 0,
    entries: 0,
    maxEntries: options.maxEntries ?? MAX_TOTAL_ENTRIES,
    roots: 0,
  };
  const ancestors = await workspaceAncestors(options.cwd, io);
  const repoRoot = ancestors.at(-1) ?? path.resolve(options.cwd);
  const home = path.resolve(options.home);

  // Phase 1: scan standard workspace and global skill roots first.
  const primarySkillRoots = new Set<string>();
  for (const ancestor of ancestors) {
    for (const dotDir of WORKSPACE_CUSTOMIZATION_DIRS) {
      addRootWithBudget(primarySkillRoots, path.join(ancestor, dotDir, "skills"), budget);
    }
    addRootWithBudget(primarySkillRoots, path.join(ancestor, ".claude", "skills"), budget);
  }
  for (const root of [
    path.join(home, ".agents", "skills"),
    path.join(home, ".agent", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
    path.join(home, ".gemini", "config", "skills"),
    path.join(home, ".gemini", "skills"),
  ]) {
    addRootWithBudget(primarySkillRoots, root, budget);
  }

  const skills = new Map<string, Set<string>>();
  const visitedDirs = new Set<string>();
  await Promise.all(
    [...primarySkillRoots].map((root) => scanSkillRoot(root, visitedDirs, skills, budget, io)),
  );

  // Phase 2: use remaining budget for configured skills.json/plugins.json and plugin skill trees.
  const extraSkillRoots = new Set<string>();
  const pluginRoots = new Set<string>();
  addRootWithBudget(pluginRoots, path.join(home, ".gemini", "config", "plugins"), budget);
  const visitedConfigs = new Set<string>();

  await collectConfiguredRoots(
    path.join(home, ".gemini", "config", "skills.json"),
    repoRoot,
    home,
    "skills",
    visitedConfigs,
    extraSkillRoots,
    pluginRoots,
    budget,
    io,
  );
  await collectConfiguredRoots(
    path.join(home, ".gemini", "config", "plugins.json"),
    repoRoot,
    home,
    "plugins",
    visitedConfigs,
    extraSkillRoots,
    pluginRoots,
    budget,
    io,
  );

  for (const ancestor of ancestors) {
    for (const dotDir of WORKSPACE_CUSTOMIZATION_DIRS) {
      const base = path.join(ancestor, dotDir);
      addRootWithBudget(pluginRoots, path.join(base, "plugins"), budget);
      await collectConfiguredRoots(
        path.join(base, "skills.json"),
        repoRoot,
        home,
        "skills",
        visitedConfigs,
        extraSkillRoots,
        pluginRoots,
        budget,
        io,
      );
      await collectConfiguredRoots(
        path.join(base, "plugins.json"),
        repoRoot,
        home,
        "plugins",
        visitedConfigs,
        extraSkillRoots,
        pluginRoots,
        budget,
        io,
      );
    }
  }

  await Promise.all(
    [...pluginRoots].map((root) => collectPluginSkillRoots(root, extraSkillRoots, budget, io)),
  );
  await Promise.all(
    [...extraSkillRoots].map((root) => scanSkillRoot(root, visitedDirs, skills, budget, io)),
  );
  return skills;
}

/**
 * Match a raw ACP command entry against discovered skills by both name and
 * non-empty normalized description so a genuine native command sharing a skill
 * name (or having no description) is retained.
 */
export function isDiscoveredAntigravitySkill(
  command: { name: string; description?: string },
  discoveredSkills: DiscoveredAntigravitySkills,
): boolean {
  const name = command.name.trim().replace(/^\//u, "");
  const description = normalizeSkillDescription(command.description);
  if (!name || !description) return false;
  const descriptions = discoveredSkills.get(name);
  if (!descriptions) return false;
  return descriptions.has(description);
}
