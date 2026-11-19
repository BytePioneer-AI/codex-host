import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  globalRoots,
  projectRoots,
  SKILL_LIBRARY_LIMITS as limits,
  type SkillRoot,
} from "./directories.js";
import { exists, scanRoot, type LibrarySkill, type RootSnapshot } from "./scan.js";

export { SKILL_DIRECTORIES, SKILL_LIBRARY_LIMITS } from "./directories.js";
export type { LibrarySkill } from "./scan.js";

export interface SkillLibrarySnapshot {
  revision: number;
  complete: boolean;
  skills: LibrarySkill[];
  warnings?: string[];
}

interface Index {
  cwd?: string;
  roots: Map<string, RootSnapshot>;
  complete: boolean;
  checkedAt: number;
  pending?: Promise<void>;
  warnings: string[];
}

export class SkillLibrary {
  readonly #home: string;
  readonly #codexHome: string;
  readonly #global: Index = this.#index();
  readonly #workspaces = new Map<string, Index>();
  readonly #listeners = new Set<(cwd?: string) => void>();
  #revision = 0;
  #disposed = false;

  constructor(options: { home?: string; codexHome?: string } = {}) {
    this.#home = options.home ?? homedir();
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.#home, ".codex");
  }

  #index(cwd?: string): Index {
    return {
      ...(cwd ? { cwd } : {}),
      roots: new Map(),
      complete: false,
      checkedAt: 0,
      warnings: [],
    };
  }

  start(): void {
    if (!this.#global.complete) this.#refresh(this.#global);
  }

  prepare(cwd: string): void {
    this.#getWorkspace(cwd);
  }

  subscribe(listener: (cwd?: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#workspaces.clear();
    this.#listeners.clear();
  }

  #getWorkspace(cwd: string): Index {
    const key = resolve(cwd);
    let index = this.#workspaces.get(key);
    if (!index) index = this.#index(key);
    this.#workspaces.delete(key);
    this.#workspaces.set(key, index);
    while (this.#workspaces.size > limits.workspaces) {
      const oldest = this.#workspaces.keys().next().value;
      if (oldest !== undefined) this.#workspaces.delete(oldest);
    }
    if (!index.complete || Date.now() - index.checkedAt >= limits.freshMs) this.#refresh(index);
    return index;
  }

  #current(index: Index): boolean {
    return (
      !this.#disposed &&
      (index === this.#global ||
        (index.cwd !== undefined && this.#workspaces.get(index.cwd) === index))
    );
  }

  #publish(index: Index, before: string): void {
    if (!this.#current(index) || before === this.#signature(index)) return;
    this.#revision++;
    for (const listener of this.#listeners) listener(index.cwd);
  }

  #signature(index: Index): string {
    return JSON.stringify([index.complete, this.#skills(index), this.#warnings(index)]);
  }

  #skills(index: Index): LibrarySkill[] {
    return [...index.roots.values()]
      .flatMap((root) =>
        [...root.files.values()].flatMap((file) => (file.skill ? [file.skill] : [])),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  #warnings(index: Index): string[] {
    return [
      ...index.warnings,
      ...[...index.roots.values()].flatMap((root) => root.warnings),
    ].sort();
  }

  #refresh(index: Index): void {
    if (index.pending || this.#disposed) return;
    index.pending = (async () => {
      let roots: SkillRoot[];
      try {
        roots = index.cwd
          ? await projectRoots(index.cwd, exists)
          : globalRoots(this.#home, this.#codexHome);
      } catch (error) {
        if (this.#current(index)) {
          const before = this.#signature(index);
          index.warnings = [String(error)];
          index.complete = true;
          this.#publish(index, before);
        }
        return;
      }
      const results = await Promise.all(
        roots.map(async (root) => {
          const result = await scanRoot(root, index.roots.get(root.path));
          if (this.#current(index) && !index.complete) {
            const before = this.#signature(index);
            index.roots.set(root.path, result);
            this.#publish(index, before);
          }
          return [root.path, result] as const;
        }),
      );
      if (!this.#current(index)) return;
      const before = this.#signature(index);
      index.roots = new Map(results);
      index.warnings = [];
      index.complete = true;
      this.#publish(index, before);
    })().finally(() => {
      index.checkedAt = Date.now();
      delete index.pending;
    });
  }

  /** Ready reads touch memory only; stale reads schedule validation without waiting for it. */
  async list(options: { cwd?: string | undefined } = {}): Promise<SkillLibrarySnapshot> {
    this.start();
    const project = options.cwd ? this.#getWorkspace(options.cwd) : undefined;
    const indexes = project ? [project, this.#global] : [this.#global];
    for (const index of indexes) {
      if (Date.now() - index.checkedAt >= limits.freshMs) this.#refresh(index);
    }
    if (indexes.some((index) => !index.complete)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(indexes.map((index) => index.pending)),
        new Promise<void>((done) => {
          timer = setTimeout(done, limits.firstScanWaitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const seen = new Set<string>();
    const skills = indexes
      .flatMap((index) => this.#skills(index))
      .filter((skill) => {
        if (seen.has(skill.path)) return false;
        seen.add(skill.path);
        return true;
      });
    const warnings = indexes.flatMap((index) => this.#warnings(index));
    return {
      revision: this.#revision,
      complete: indexes.every((index) => index.complete),
      skills,
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
