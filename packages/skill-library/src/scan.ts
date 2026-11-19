import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";

import {
  SKILL_LIBRARY_LIMITS as limits,
  SKIPPED_DIRECTORIES,
  type SkillRoot,
} from "./directories.js";

export interface LibrarySkill {
  name: string;
  description?: string;
  path: string;
  scope: "project" | "global";
  source: string;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  skill?: LibrarySkill;
  warning?: string;
}

export interface RootSnapshot {
  files: Map<string, CachedFile>;
  directories: Map<string, string>;
  warnings: string[];
}

let active = 0;
const waiting: (() => void)[] = [];

/** All library instances share the same file-operation budget. */
async function io<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= limits.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

export function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await io(() => stat(path));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function within(path: string, directory: string): boolean {
  const suffix = relative(directory, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

async function metadata(
  path: string,
  root: SkillRoot,
): Promise<Pick<CachedFile, "skill" | "warning">> {
  const prefix = await io(async () => {
    const file = await open(path, "r");
    try {
      // Check the opened file as well: a replaced path must not turn into a device read.
      if (!(await file.stat()).isFile()) throw new Error("SKILL.md is not a regular file");
      const buffer = Buffer.alloc(limits.frontmatterBytes);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  });
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(prefix);
  if (!match) return { warning: `${path}: Missing or oversized YAML frontmatter` };
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length) return { warning: `${path}: Invalid YAML frontmatter` };
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  const data = value as { name?: unknown; description?: unknown } | null;
  if (!data || typeof data.name !== "string" || !data.name || /[\s[\]]/u.test(data.name)) {
    return { warning: `${path}: Skill name is missing or contains whitespace or brackets` };
  }
  return {
    skill: {
      name: data.name,
      ...(typeof data.description === "string" ? { description: data.description } : {}),
      path,
      source: root.source,
      scope: root.scope,
    },
  };
}

/** Re-list every visited directory, probing SKILL.md even when it was absent last time. */
export async function scanRoot(root: SkillRoot, previous?: RootSnapshot): Promise<RootSnapshot> {
  const files = new Map<string, CachedFile>();
  const warnings: string[] = [];
  const directories = new Map<string, string>();
  const visited = new Set<string>();
  const retain = (directory: string, error: unknown) => {
    directory = previous?.directories.get(directory) ?? directory;
    for (const [alias, canonical] of previous?.directories ?? []) {
      if (within(canonical, directory)) directories.set(alias, canonical);
    }
    warnings.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    for (const [path, file] of previous?.files ?? []) {
      if (within(path, directory)) files.set(path, file);
    }
  };
  const visit = async (directory: string, depth: number): Promise<void> => {
    let resolved = directory;
    try {
      resolved = await io(() => realpath(directory));
      directories.set(directory, resolved);
      if (visited.has(resolved)) return;
      visited.add(resolved);
      if (depth > 0) {
        const path = join(resolved, "SKILL.md");
        try {
          const info = await io(() => stat(path));
          if (info.isFile()) {
            const canonical = await io(() => realpath(path));
            const cached = previous?.files.get(canonical);
            try {
              const file =
                cached?.mtimeMs === info.mtimeMs && cached.size === info.size
                  ? cached
                  : {
                      mtimeMs: info.mtimeMs,
                      size: info.size,
                      ...(await metadata(canonical, root)),
                    };
              files.set(canonical, file);
              if (file.warning) warnings.push(file.warning);
            } catch (error) {
              if (!missing(error)) retain(resolved, error);
            }
            return;
          }
        } catch (error) {
          if (!missing(error)) {
            retain(resolved, error);
            return;
          }
        }
      }
      if (depth >= limits.depth) return;
      const children = (await io(() => readdir(resolved, { withFileTypes: true })))
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            !entry.name.startsWith(".") &&
            !SKIPPED_DIRECTORIES.has(entry.name),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      if (children.length > limits.children) {
        warnings.push(`${resolved}: Skill directory limit reached`);
        for (const child of children.slice(limits.children)) {
          retain(join(resolved, child.name), "Skill directory limit reached");
        }
      }
      await Promise.all(
        children.slice(0, limits.children).map(async (child) => {
          const path = join(resolved, child.name);
          if (child.isSymbolicLink()) {
            try {
              if (!(await io(() => stat(path))).isDirectory()) return;
            } catch (error) {
              if (!missing(error)) retain(path, error);
              return;
            }
          }
          await visit(path, depth + 1);
        }),
      );
    } catch (error) {
      if (!missing(error)) retain(resolved, error);
    }
  };
  await visit(root.path, 0);
  return { files, directories, warnings };
}
