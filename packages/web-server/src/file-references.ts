/** Web file discovery uses server-owned workspace identities and DSH's path index. */
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from "./workspace-file-search.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

/** Bounded workspace cache shared by local Threads and their drafts. */
export class WebFileReferences {
  private readonly searches = new Map<
    string,
    { search: WorkspaceFileSearch; refreshedAt: number }
  >();
  private readonly lifetime = new AbortController();

  constructor(private readonly workspace: (sessionId: string) => string | undefined) {}

  register(rpc: RpcRegistry): void {
    rpc.register("fileReferences/list", async (args) => {
      if (typeof args.agentId !== "string" || typeof args.query !== "string")
        throw new RpcError("gateway/bad-request", "A session and file query are required.");
      this.lifetime.signal.throwIfAborted();
      const root = this.workspace(args.agentId);
      if (!root)
        throw new RpcError("gateway/lookup-not-found", "This session has no local workspace.");
      let entry = this.searches.get(root);
      if (!entry) {
        if (this.searches.size >= 16) {
          const oldest = this.searches.entries().next().value;
          if (oldest) {
            oldest[1].search.dispose();
            this.searches.delete(oldest[0]);
          }
        }
        entry = {
          search: new WorkspaceFileSearch(root, {
            maxResults: DEFAULT_FILE_SEARCH_MAX_RESULTS,
            maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
            excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
          }),
          refreshedAt: Date.now(),
        };
      } else if (Date.now() - entry.refreshedAt >= 2_000) {
        // Web observes edits from multiple Harnesses and external editors.
        // Keep serving the settled index while DSH rebuilds it in the background.
        entry.search.invalidate();
        entry.refreshedAt = Date.now();
      }
      this.searches.delete(root);
      this.searches.set(root, entry);
      return entry.search.list(args.query, this.lifetime.signal);
    });
  }

  close(): void {
    this.lifetime.abort();
    for (const { search } of this.searches.values()) search.dispose();
    this.searches.clear();
  }
}
