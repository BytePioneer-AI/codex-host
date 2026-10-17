import type { DraftConfiguration } from "@codexhost/session-runtime";
import type { WebCodexConfiguration, WebCodexRequest } from "@codexhost/shared-contracts";
import type { LocalOrganizationState } from "@codexhost/session-runtime";
import type { Workspaces } from "./workspaces.ts";
import type { ChHostClient } from "./ch-host-client.ts";
import { HarnessRegistry, type Inspection } from "./harnesses.ts";
import { bridgeSessionInteraction, type SessionNotification } from "./sessions.ts";
import { requestOf } from "./store.ts";
import { RpcError, type EventHub, type RpcRegistry, type StreamRegistry } from "./transport.ts";

const operations = {
  "session/list": "list",
  "session/create": "create",
  "session/modelCatalog": "modelCatalog",
  "session/selectModel": "selectModel",
  "session/prompt": "prompt",
  "session/cancel": "cancel",
  "session/updateQueue": "updateQueue",
  "session/rename": "rename",
  "session/fork": "fork",
  "session/search": "search",
  "session/page": "page",
  "session/projections": "projections",
  "codexhost/importSources": "importSources",
  "codexhost/importCandidates": "importCandidates",
  "codexhost/import": "import",
  "commands/list": "listCommands",
  "commands/execute": "executeCommand",
  "permissionPresets/catalog": "permissionCatalog",
} as const;
function sessionId(input: Record<string, unknown>): string | undefined {
  const address = input.address as Record<string, unknown> | undefined;
  const id = input.sessionId ?? input.agentId ?? address?.sessionId ?? address?.childSessionId;
  return typeof id === "string" ? id : undefined;
}

/** Viewer only. It holds neither a native Adapter nor a writable Session store. */
export class RemoteCodexSessions {
  private scope = "";
  private sessionIds = new Set<string>();
  private closed = false;
  private unsubscribe: (() => void) | undefined;
  private readonly controllers = new Set<AbortController>();
  private readonly interactions = new Map<string, { cancel(): void }>();
  private refresh: Promise<void> | undefined;
  private organizationView: Workspaces | undefined;
  private notificationCursor = 0;
  private notificationEpoch = "";
  private dirty = false;
  private needsConfiguration = false;
  notifier: ((notification: SessionNotification) => void) | undefined;
  readonly harnesses: Pick<
    HarnessRegistry,
    "ids" | "manifest" | "iconPath" | "inspect" | "modelCatalog" | "close"
  >;
  private get channel() {
    const channel = this.host.webCodex;
    if (!channel) throw new RpcError("owner/offline", "Isolated owner is disconnected");
    return channel;
  }
  private constructor(
    private readonly host: ChHostClient,
    private readonly events: EventHub,
    private readonly configuration: WebCodexConfiguration,
  ) {
    const metadata = new HarnessRegistry(configuration.pluginRoots, new Set(["codex"]), {
      scope: "web-codex",
    });
    this.harnesses = {
      ids: () => ["codex"],
      manifest: (id) => metadata.manifest(id),
      iconPath: (id) => metadata.iconPath(id),
      inspect: async (id) => {
        if (id !== "codex") throw new RpcError("scope/unknown", "Harness outside isolated source");
        return this.call<Inspection>("inspect", {});
      },
      modelCatalog: () => this.call("modelCatalog", {}),
      close: async () => {},
    };
  }
  static async connect(host: ChHostClient, events: EventHub, configuration: WebCodexConfiguration) {
    if (!host.webCodex)
      throw new RpcError(
        "host/unsupported",
        "Shared Host does not support isolated Codex ownership; update Host.",
      );
    const remote = new RemoteCodexSessions(host, events, configuration);
    const value = await host.webCodex.configure(configuration);
    remote.scope = value.scope;
    remote.sessionIds = new Set(value.sessionIds);
    remote.notificationCursor = value.notificationCursor;
    remote.notificationEpoch = value.cursor.epoch;
    remote.unsubscribe = host.realtime?.subscribe((event) => {
      if (
        event.type === "hello" ||
        (event.type === "web-codex-changed" && event.scope === remote.scope)
      )
        void remote.reconcile(event.type === "hello").catch((error) => {
          if (!remote.closed)
            events.emit(
              "codexhost/preferences-error",
              error instanceof Error ? error.message : String(error),
            );
        });
      if (event.type === "connection" && !event.online) remote.cancelInteractions();
    });
    await remote.reconcile(false);
    return remote;
  }
  async attachOrganization(view: Workspaces): Promise<void> {
    this.organizationView = view;
    view.useLocalOrganizationRemote({
      request: (action, input) => this.call("organization", { action, ...input }),
      refresh: () => this.reconcile(false),
      owns: (id) => this.owns(id),
    });
    await this.reconcile(false);
  }
  owns(id: string): boolean {
    return this.sessionIds.has(id);
  }
  ids(): ReadonlySet<string> {
    return new Set(this.sessionIds);
  }
  async call<T = unknown>(
    operation: WebCodexRequest["operation"],
    input: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed || !this.host.webCodex)
      throw new RpcError("owner/offline", "Isolated owner is disconnected");
    const id = sessionId(input);
    return this.host.webCodex.request<T>({
      epoch: this.host.webCodex.epoch,
      address: { scope: this.scope, ...(id ? { sessionId: id } : {}) },
      operation,
      input,
    });
  }
  async prepareDraft(
    request: { sessionId: string; cwd?: string },
    configuration: DraftConfiguration,
  ): Promise<void> {
    await this.call("prepareDraft", { ...request, configuration });
    this.sessionIds.add(request.sessionId);
  }
  private cancelInteractions() {
    for (const value of this.interactions.values()) value.cancel();
    this.interactions.clear();
  }
  private reconcile(reconfigure: boolean): Promise<void> {
    this.dirty = true;
    this.needsConfiguration ||= reconfigure;
    if (this.refresh) return this.refresh;
    const running = (async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        const configure = this.needsConfiguration;
        this.needsConfiguration = false;
        if (configure) {
          const configuration = { ...this.configuration };
          delete configuration.migrateSource;
          delete configuration.legacyWriterStopped;
          const value = await this.channel.configure(configuration);
          if (value.cursor.epoch !== this.notificationEpoch) {
            this.notificationCursor = value.notificationCursor;
            this.notificationEpoch = value.cursor.epoch;
          }
          if (value.scope !== this.scope)
            throw new RpcError("scope/conflict", "Owner scope changed");
        }
        const epoch = this.channel.epoch;
        const listing = await this.call<{ items: Array<{ sessionId: string }> }>("list", {});
        if (this.closed) return;
        if (this.dirty || epoch !== this.channel.epoch) {
          this.dirty = true;
          this.needsConfiguration ||= epoch !== this.channel.epoch;
          continue;
        }
        this.sessionIds = new Set(listing.items.map((row) => row.sessionId));
        for (const row of listing.items) this.events.emit("api-session/added", row);
        if (this.organizationView) {
          const organization = await this.call<LocalOrganizationState>("organization", {
            action: "snapshot",
          });
          if (this.closed) return;
          if (this.dirty || epoch !== this.channel.epoch) {
            this.dirty = true;
            this.needsConfiguration ||= epoch !== this.channel.epoch;
            continue;
          }
          this.organizationView.setLocalOrganization(organization);
        }
        const pending = await this.call<
          Array<{
            requestId: string;
            sessionId: string;
            interaction: Record<string, unknown> & { type: string };
          }>
        >("interactions", {});
        if (this.closed) return;
        if (this.dirty || epoch !== this.channel.epoch) {
          this.dirty = true;
          this.needsConfiguration ||= epoch !== this.channel.epoch;
          continue;
        }
        const notices = await this.call<{
          cursor: number;
          items: Array<{ notification: SessionNotification }>;
        }>("notifications", { after: this.notificationCursor });
        if (this.closed) return;
        if (this.dirty || epoch !== this.channel.epoch) {
          this.dirty = true;
          this.needsConfiguration ||= epoch !== this.channel.epoch;
          continue;
        }
        this.notificationCursor = notices.cursor;
        for (const notice of notices.items) this.notifier?.(notice.notification);
        const active = new Set(pending.map((value) => value.requestId));
        for (const [id, invocation] of this.interactions)
          if (!active.has(id)) {
            invocation.cancel();
            this.interactions.delete(id);
          }
        for (const value of pending) {
          if (this.interactions.has(value.requestId)) continue;
          const epoch = this.channel.epoch;
          const invocation = bridgeSessionInteraction(
            this.events,
            value.sessionId,
            value.interaction,
          );
          this.interactions.set(value.requestId, invocation);
          void invocation.result
            .then(async (result) => {
              if (this.closed || epoch !== this.channel.epoch) return;
              await this.call("respond", {
                sessionId: value.sessionId,
                requestId: value.requestId,
                result,
              });
            })
            .catch(() => {})
            .finally(() => this.interactions.delete(value.requestId));
        }
      }
    })();
    this.refresh = running;
    void running
      .finally(() => {
        if (this.refresh === running) this.refresh = undefined;
        if (this.dirty && !this.closed)
          queueMicrotask(() => {
            void this.reconcile(false).catch((error) => {
              if (!this.closed)
                this.events.emit(
                  "codexhost/preferences-error",
                  error instanceof Error ? error.message : String(error),
                );
            });
          });
      })
      .catch(() => {});
    return running;
  }
  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    for (const [method, operation] of Object.entries(operations))
      rpc.register(method, async (args) => {
        const input = requestOf<Record<string, unknown>>(args);
        const value = await this.call(operation, input);
        if (operation === "list")
          this.sessionIds = new Set(
            (value as { items: Array<{ sessionId: string }> }).items.map((row) => row.sessionId),
          );
        if (["create", "import", "fork"].includes(operation)) {
          const id = (value as { sessionId?: string })?.sessionId;
          if (id) this.sessionIds.add(id);
        }
        return value;
      });
    rpc.register("session/workspacePathApplications", () => ({ applications: [] }));
    rpc.register("session/openWorkspacePath", () => {
      throw new RpcError("session/open-unavailable", "Opening host paths is unavailable in Web");
    });
    for (const stream of ["follow", "control"] as const)
      streams.register(`session/${stream}`, async (args, sink) => {
        const input = requestOf<Record<string, unknown>>(args);
        const id = sessionId(input);
        const controller = new AbortController();
        this.controllers.add(controller);
        sink.onClose(() => {
          controller.abort();
          this.controllers.delete(controller);
        });
        await this.channel.stream(
          {
            epoch: this.channel.epoch,
            address: { scope: this.scope, ...(id ? { sessionId: id } : {}) },
            stream,
            input,
          },
          {
            signal: controller.signal,
            item: (value) => {
              if (!sink.closed) sink.push(value);
            },
            fail: (error) => sink.fail("owner/disconnected", error.message),
          },
        );
      });
  }
  registerCommands(): void {}
  registerImport(): void {}
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.cancelInteractions();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
