import {
  clientThreadTreeSchema,
  THREAD_CATALOG_READ_METHOD,
  type ThreadCatalogReadResult,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThread } from "./ch-thread-view.ts";
import { RpcError } from "./transport.ts";

/** Bound only ancestor metadata reads; archive traversal uses the complete Host relationship map. */
export const THREAD_TREE_ANCESTOR_LIMIT = 64;

export class ChThreadTree {
  private parents: Record<string, string> = {};
  constructor(private readonly host: ChHostClient) {}

  async refresh(): Promise<void> {
    this.parents = clientThreadTreeSchema.parse(
      await this.host.request("codexhost/thread/tree/read", {}),
    ).parents;
  }

  parent(id: string): string | null {
    return Object.hasOwn(this.parents, id) ? (this.parents[id] ?? null) : null;
  }

  withAncestors(ids: Iterable<string>): Set<string> {
    const result = new Set(ids);
    for (const seed of [...result]) {
      const visited = new Set([seed]);
      let id = seed;
      for (let depth = 0; depth < THREAD_TREE_ANCESTOR_LIMIT; depth++) {
        const parent = this.parent(id);
        if (!parent || visited.has(parent)) break;
        visited.add(parent);
        result.add(parent);
        id = parent;
      }
    }
    return result;
  }

  async supplement(
    rows: Map<string, ChThread>,
    read: (id: string) => Promise<ChThread>,
  ): Promise<void> {
    for (const id of this.withAncestors(rows.keys())) {
      if (rows.has(id)) continue;
      try {
        rows.set(id, await read(id));
      } catch {
        // A deleted or unconfirmable ancestor leaves its children visible at the top level.
      }
    }
  }

  private async readArchivedIds(): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let archived: string | undefined;
    for (;;) {
      const page = await this.host.request<ThreadCatalogReadResult>(THREAD_CATALOG_READ_METHOD, {
        includeArchived: true,
        officialCursor: { live: null, ...(archived === undefined ? {} : { archived }) },
      });
      for (const id of page.archivedThreadIds) ids.add(id);
      const next = page.officialCursor?.archived;
      if (next == null) return ids;
      if (seen.has(next))
        throw new RpcError("host/catalog-invalid", "Host archive cursor did not advance.");
      seen.add(next);
      archived = next;
    }
  }

  async archive(
    id: string,
    archived: boolean,
    archivedIds: ReadonlySet<string>,
    setArchived: (id: string) => Promise<void>,
  ): Promise<void> {
    await this.refresh();
    const children = new Map<string, string[]>();
    for (const [child, parent] of Object.entries(this.parents)) {
      const list = children.get(parent) ?? [];
      list.push(child);
      children.set(parent, list);
    }
    const queue = [id];
    const visited = new Set<string>();
    const failedSessionIds: string[] = [];
    let confirmedArchiveIds: Promise<ReadonlySet<string>> | undefined;
    for (const next of queue) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(...(children.get(next) ?? []));
      if (next !== id && archived && archivedIds.has(next)) continue;
      try {
        if (next !== id && !archived && !archivedIds.has(next)) {
          // Native archive IDs cover only loaded pages; absence needs a complete archive read.
          confirmedArchiveIds ??= this.readArchivedIds();
          if (!(await confirmedArchiveIds).has(next)) continue;
        }
        await setArchived(next);
      } catch (error) {
        if (next === id) throw error;
        failedSessionIds.push(next);
      }
    }
    if (failedSessionIds.length)
      throw new RpcError(
        "session/archive-partial",
        "Some Threads could not be archived or restored.",
        { failedSessionIds },
      );
  }
}
