import type { HostClientUpdate } from "@codexhost/desktop-control";
import {
  clientThreadPinsSchema,
  clientThreadSnapshotSchema,
  type ClientChannelResponse,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
  type RemotePeerManifest,
} from "@codexhost/shared-contracts";
import type { ChHostClient, ChPinChange, ChProjectSnapshot } from "./ch-host-client.ts";
import { RpcError } from "./transport.ts";

export interface PeerChTransport {
  /** POST /api/ch/v1/<route>, returning the JSON `result`; errors map to RpcError via peerFetch. */
  post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T>;
  /** Fed by PeerHostClient's /api/ch/v1/events loop. */
  subscribe(listener: (update: HostClientUpdate) => void): () => void;
  manifest(): RemotePeerManifest | undefined;
}

/** ChHostClient implementation backed by a remote Peer's /api/ch/v1/* endpoints. */
export class PeerChHostClient implements ChHostClient {
  private closed = false;
  private readonly unsubscribers = new Set<() => void>();

  readonly realtime: NonNullable<ChHostClient["realtime"]>;

  constructor(private readonly transport: PeerChTransport) {
    this.realtime = {
      subscribe: (listener: (event: HostClientUpdate) => void) => {
        if (this.closed) return () => {};
        const stop = this.transport.subscribe(listener);
        let active = true;
        const unsubscribe = () => {
          if (!active) return;
          active = false;
          this.unsubscribers.delete(unsubscribe);
          stop();
        };
        this.unsubscribers.add(unsubscribe);
        return unsubscribe;
      },
      request: <T = unknown>(method: string, params: Record<string, unknown>) =>
        this.request<T>(method, params),
      snapshot: async (
        threadId: string,
        options?: ClientSnapshotOptions,
      ): Promise<ClientThreadSnapshot> => {
        this.ensureOpen();
        const raw = await this.transport.post("snapshot", {
          threadId,
          ...(options ?? {}),
        });
        return clientThreadSnapshotSchema.parse(raw);
      },
      respond: async (input: ClientChannelResponse): Promise<{ resolved: boolean }> => {
        this.ensureOpen();
        return this.transport.post<{ resolved: boolean }>("respond", input);
      },
    };
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new RpcError("remote/offline", "Remote peer host client is closed");
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    this.ensureOpen();
    return this.transport.post<T>("rpc", { method, params });
  }

  async projects(threadIds: string[]): Promise<ChProjectSnapshot> {
    const manifestProjects = this.transport.manifest()?.projects ?? [];
    const wanted = new Set(threadIds);
    const assignments: Record<string, string> = {};
    const projects = manifestProjects.map((project) => {
      for (const id of project.threadIds) {
        if (wanted.has(id) && !Object.hasOwn(assignments, id)) {
          assignments[id] = project.id;
        }
      }
      return { id: project.id, name: project.name, rootPaths: [project.path] };
    });
    return { projects, assignments, projectless: [] };
  }

  async pins(change?: ChPinChange): Promise<string[]> {
    const value = await this.request(
      change ? "codexhost/thread/pins/set" : "codexhost/thread/pins/list",
      change ? { ...change } : {},
    );
    const parsed = clientThreadPinsSchema.safeParse(value);
    if (!parsed.success) {
      throw new RpcError("host/pins-invalid", "Host returned an invalid native pin snapshot.");
    }
    if (change && parsed.data.threadIds.includes(change.threadId) !== change.pinned) {
      throw new RpcError("host/pins-unconfirmed", "Host did not confirm the requested pin state.");
    }
    return [...new Set(parsed.data.threadIds)];
  }

  manifestEpoch(): string | undefined {
    return this.transport.manifest()?.epoch;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of [...this.unsubscribers]) unsubscribe();
    this.unsubscribers.clear();
  }
}
