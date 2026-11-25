/** Web file discovery uses server-owned workspace identities and DSH's path index. */
import { isRemoteWorkspaceScopeId } from "./remote-peer-workspace-files.ts";
import { WorkspaceFileSearchCache, type FileReferenceCandidate } from "./workspace-file-search.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

export type RemoteFileReferencesSearch = (
  sessionId: string,
  query: string,
  signal: AbortSignal,
) => Promise<FileReferenceCandidate[]>;

/** Bounded workspace cache shared by local Threads and their drafts, with remote Peer delegation. */
export class WebFileReferences {
  private readonly cache = new WorkspaceFileSearchCache();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly workspace: (sessionId: string) => string | undefined,
    private remoteSearch?: RemoteFileReferencesSearch,
  ) {}

  setRemoteSearch(search: RemoteFileReferencesSearch | undefined): void {
    this.remoteSearch = search;
  }

  register(rpc: RpcRegistry): void {
    rpc.register("fileReferences/list", async (args, context) => {
      if (typeof args.agentId !== "string" || typeof args.query !== "string")
        throw new RpcError("gateway/bad-request", "A session and file query are required.");
      this.lifetime.signal.throwIfAborted();
      const signal = context.signal
        ? AbortSignal.any([this.lifetime.signal, context.signal])
        : this.lifetime.signal;
      if (isRemoteWorkspaceScopeId(args.agentId)) {
        if (!this.remoteSearch) {
          throw new RpcError(
            "remote/workspace-files-unsupported",
            "Remote workspace file search is unavailable.",
          );
        }
        return this.remoteSearch(args.agentId, args.query, signal);
      }
      const root = this.workspace(args.agentId);
      if (!root)
        throw new RpcError("gateway/lookup-not-found", "This session has no local workspace.");
      return this.cache.list(root, args.query, signal);
    });
  }

  close(): void {
    this.lifetime.abort();
    this.cache.close();
  }
}
