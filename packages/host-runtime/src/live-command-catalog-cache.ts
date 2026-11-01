import path from "node:path";

import type { HarnessCommandCatalog } from "@codexhost/shared-contracts";

const MAX_ENTRIES = 64;

/**
 * Whether a Session catalog carries anything beyond the Adapter's static
 * built-ins. A Session whose native process has not started yet reports only
 * the built-ins, which is not a live catalog.
 */
export function isLiveCommandCatalog(
  catalog: HarnessCommandCatalog,
  staticCatalog: HarnessCommandCatalog,
): boolean {
  const staticIds = new Set<string>(staticCatalog.commands.map(({ id }) => id));
  return catalog.commands.some(({ id }) => !staticIds.has(id));
}

/**
 * Last live command catalog seen per Harness and workspace, so a new draft in
 * a known workspace can show its commands and skills before its own native
 * process starts. In memory only; entries refresh whenever a Session of the
 * same Harness and workspace reports its catalog again. Project-level commands
 * and skills differ per workspace, so entries never cross workspaces.
 */
export class LiveCommandCatalogCache {
  readonly #entries = new Map<string, HarnessCommandCatalog>();

  #key(harnessId: string, cwd: string): string {
    return `${harnessId}\0${path.resolve(cwd)}`;
  }

  remember(harnessId: string, cwd: string, catalog: HarnessCommandCatalog): void {
    const key = this.#key(harnessId, cwd);
    this.#entries.delete(key);
    this.#entries.set(key, catalog);
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  lookup(harnessId: string, cwd: string): HarnessCommandCatalog | undefined {
    return this.#entries.get(this.#key(harnessId, cwd));
  }
}

export function sameWorkspace(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
