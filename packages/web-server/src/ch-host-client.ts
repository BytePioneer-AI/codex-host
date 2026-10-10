/** Reach the already-running local CH Host through its installed, versioned Desktop routing.
 * Never install Renderer code, launch Desktop, own a Mapping Store, or spawn a Harness.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CdpClient,
  listCdpTargets,
  HostClientChannel,
  discoverHostClientChannel,
  type HostClientUpdate,
} from "@codexhost/desktop-control";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClientThreadSnapshot,
  ClientChannelResponse,
  ClientChannelCursor,
} from "@codexhost/shared-contracts";
import { RpcError } from "./transport.ts";

export interface ChHostClient {
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  projects(threadIds: string[]): Promise<ChProjectSnapshot>;
  close(): void;
  readonly realtime?: {
    subscribe(listener: (event: HostClientUpdate) => void, after?: ClientChannelCursor): () => void;
    request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
    snapshot(threadId: string): Promise<ClientThreadSnapshot>;
    respond(input: ClientChannelResponse): Promise<{ resolved: boolean }>;
  };
}

export interface ChProjectSnapshot {
  projects: Array<{ id: string; name: string; rootPaths: string[] }>;
  assignments: Record<string, string>;
  projectless: string[];
}

const exec = promisify(execFile);
const METHODS = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt",
  "codexhost/harness/plugins/list",
  "codexhost/harness/inspect",
  "codexhost/thread/inspect",
  "codexhost/thread/ownership/list",
  "codexhost/thread/model/select",
  "codexhost/thread/thinking/select",
  "codexhost/thread/permission-mode/select",
  "codexhost/thread/commands/inspect",
  "codexhost/thread/command/execute",
  "codexhost/thread/fork",
  "codexhost/harness/session-import/sources",
  "codexhost/harness/session-import/list",
  "codexhost/harness/session-import/import",
]);

/** Discover only an existing Codex process's debugger flag; no process is launched or signalled. */
async function desktopEndpoints(explicit?: string): Promise<string[]> {
  if (explicit) return [explicit];
  if (process.platform === "win32")
    throw new RpcError(
      "host/endpoint-required",
      "Specify --ch-cdp for the running Desktop on Windows.",
    );
  const { stdout } = await exec("ps", ["-axo", "command="], { maxBuffer: 4 * 1024 * 1024 });
  const endpoints = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!/\/(?:Codex|ChatGPT)\.app\//u.test(line)) continue;
    const port = /--remote-debugging-port(?:=|\s+)(\d+)/u.exec(line)?.[1];
    if (port) endpoints.add(`http://127.0.0.1:${port}`);
  }
  return [...endpoints];
}

/** Connection loss does not retry a write: its outcome may already have applied. */
export class DesktopChHostClient implements ChHostClient {
  private client: CdpClient | undefined;
  private connecting: Promise<CdpClient> | undefined;
  private closed = false;
  constructor(private readonly endpoint?: string) {}

  private connect(): Promise<CdpClient> {
    if (this.closed)
      return Promise.reject(new RpcError("host/offline", "The CH connection is closed."));
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.discover().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async discover(): Promise<CdpClient> {
    for (const endpoint of await desktopEndpoints(this.endpoint)) {
      const targets = await listCdpTargets(endpoint).catch(() => []);
      for (const target of targets.filter((value) => value.type === "page")) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl, {
          commandTimeoutMs: 120_000,
        }).catch(() => null);
        if (!client) continue;
        try {
          const ready = await client.evaluate<boolean>(
            "!!window.__codexhostRendererBindingProbeV1 && (window.__codexhostHostRoutingV1?.knownHostIds?.() ?? []).includes('local')",
          );
          if (ready && !this.closed) {
            this.client = client;
            return client;
          }
        } catch {
          /* A detached or unrelated window is not the local Host. */
        }
        client.close();
      }
    }
    throw new RpcError(
      "host/offline",
      "The local codexhost Desktop Host is unavailable. Start Codex through codexhost; Web will not create an independent session instead.",
    );
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!METHODS.has(method))
      throw new RpcError("host/method-unavailable", `Unsupported CH method: ${method}`);
    const client = await this.connect();
    // JSON literals only, never interpolate a path, model ID or user message as executable code.
    const expression = `(async () => { const route = window.__codexhostHostRoutingV1?.forHost('local'); if (!route) return {ok:false,error:'Local Host unavailable'}; try { return {ok:true,value:await route.manager.sendRequest(${JSON.stringify(method)},${JSON.stringify(params)})}; } catch(error) { return {ok:false,error:String(error?.message ?? error)}; } })()`;
    try {
      const reply = await client.evaluate<{ ok: boolean; value?: T; error?: string }>(expression);
      if (!reply.ok)
        throw new RpcError("host/rejected", reply.error ?? "CH rejected the operation.");
      return reply.value as T;
    } catch (error) {
      if (!(error instanceof RpcError)) {
        this.client = undefined;
        client.close();
      }
      throw error instanceof RpcError
        ? error
        : new RpcError(
            "host/disconnected",
            "CH connection lost; the operation outcome may be unknown. Refresh before retrying.",
          );
    }
  }

  /** Read existing native project metadata; never save assignments or create GUI projects. */
  async projects(threadIds: string[]): Promise<ChProjectSnapshot> {
    const client = await this.connect();
    const expression = `(async () => {
      const manager = window.__codexhostHostRoutingV1?.forHost('local')?.manager;
      const storage = manager?.threadWorkspaceStorage?.storage;
      if (!storage?.readGlobalState) throw new Error('Native project metadata unavailable');
      const [local, order, assigned, projectlessIds] = await Promise.all(['local-projects','project-order','thread-project-assignments','projectless-thread-ids'].map(key => storage.readGlobalState(key)));
      const ids = ${JSON.stringify(threadIds)};
      const projects = Object.values(local ?? {}).filter(project => Array.isArray(order) && order.includes(project.id)).map(project => ({id:project.id,name:project.name,rootPaths:project.rootPaths}));
      return {projects,assignments:Object.fromEntries(ids.flatMap(id => assigned?.[id]?.projectKind === 'local' ? [[id,assigned[id].projectId]] : [])),projectless:ids.filter(id => Array.isArray(projectlessIds) && projectlessIds.includes(id))};
    })()`;
    try {
      return await client.evaluate<ChProjectSnapshot>(expression);
    } catch {
      throw new RpcError(
        "host/projects-unavailable",
        "Native project metadata is unavailable; execution cwd will not be guessed as a project.",
      );
    }
  }

  close(): void {
    this.closed = true;
    this.client?.close();
    this.client = undefined;
  }
}

/** Prefer the stable owner channel; explicit CDP remains the legacy/test route.
 * Once selected, an event connection never silently falls back after a failure.
 */
export async function createChHostClient(
  options: { cdp?: string; directory?: string } = {},
): Promise<ChHostClient> {
  const desktop = new DesktopChHostClient(options.cdp);
  const directory = options.directory ?? join(homedir(), ".codexhost", "client-hosts");
  const endpoint =
    options.cdp && !options.directory ? null : await discoverHostClientChannel(directory);
  if (!endpoint && options.directory !== undefined)
    throw new RpcError(
      "host/unavailable",
      "CH client channel not found; start an updated local Host or check --ch-control-directory.",
    );
  if (!endpoint) return desktop;
  const channel = new HostClientChannel(directory, endpoint);
  try {
    await channel.start();
  } catch (error) {
    channel.close();
    throw error;
  }
  return {
    realtime: channel,
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      try {
        return await channel.request<T>(method, params);
      } catch (error) {
        throw new RpcError(
          "host/rejected",
          error instanceof Error ? error.message : "Host request failed",
        );
      }
    },
    projects: (ids) => desktop.projects(ids),
    close() {
      channel.close();
      desktop.close();
    },
  };
}
