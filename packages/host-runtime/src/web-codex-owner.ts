import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  IsolatedSessions,
  LocalSessionOrganization,
  acquireSourceOwnerLock,
  canonicalSessionPath,
  migrateLegacyWebSource,
  recoverSessionMigration,
  type SessionOwnership,
  type SessionSink,
  type SessionNotification,
} from "@codexhost/session-runtime";
import {
  webCodexConfigurationSchema,
  webCodexRequestSchema,
  webCodexStreamRequestSchema,
  type WebCodexConfiguration,
  type WebCodexConfigurationReply,
} from "@codexhost/shared-contracts";
import type { ClientChannelEvents } from "./client-channel-events.js";
import { createWebCodexHarness } from "./web-codex-harness.js";
import { readSharedHostExitProof } from "./shared-host-exit-proof.js";

type PendingInteraction = {
  sessionId: string;
  interaction: Record<string, unknown> & { type: string };
  resolve(value: unknown): void;
  reject(reason: Error): void;
};
const sessionOperations = new Set([
  "selectModel",
  "prompt",
  "cancel",
  "updateQueue",
  "rename",
  "fork",
  "page",
  "projections",
  "listCommands",
  "executeCommand",
]);

/** One fixed isolated source next to external ownership. Never an official Codex route. */
export class SharedWebCodexOwner {
  private configuration: WebCodexConfiguration | undefined;
  private scope: string | undefined;
  private owner: IsolatedSessions | undefined;
  private organization: LocalSessionOrganization | undefined;
  private ownership: SessionOwnership | undefined;
  private harness: Awaited<ReturnType<typeof createWebCodexHarness>> | undefined;
  private configuring: Promise<WebCodexConfigurationReply> | undefined;
  private pending = new Map<string, PendingInteraction>();
  private notificationSequence = 0;
  private readonly notifications: Array<{ sequence: number; notification: SessionNotification }> =
    [];
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly receipts = new Map<
    string,
    { signature: string; result: Promise<unknown>; settled: boolean }
  >();
  private readonly root: string;
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly events: ClientChannelEvents,
    private readonly externalOwns: (id: string) => Promise<boolean>,
    private readonly preferencesRequest: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {
    if (!environment.CODEXHOST_DATA_DIR) throw new Error("Host data directory required");
    this.root = path.join(environment.CODEXHOST_DATA_DIR, "web-codex");
  }
  async initialize(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(this.root, "service-config-v1.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.configure(value);
  }
  configure(input: unknown): Promise<WebCodexConfigurationReply> {
    const requested = webCodexConfigurationSchema.parse(input);
    if (this.configuring) return this.configuring.then(() => this.configure(requested));
    const running = this.configureOnce(requested);
    this.configuring = running;
    void running
      .finally(() => {
        if (this.configuring === running) this.configuring = undefined;
      })
      .catch(() => {});
    return running;
  }
  private async configureOnce(
    requested: WebCodexConfiguration,
  ): Promise<WebCodexConfigurationReply> {
    if (this.closed) throw new Error("owner-offline");
    if (
      ![
        requested.home,
        requested.command,
        ...requested.pluginRoots,
        ...(requested.migrateSource ? [requested.migrateSource] : []),
        ...(requested.legacySource ? [requested.legacySource] : []),
      ].every(path.isAbsolute)
    )
      throw new Error("scope-conflict: configuration paths must be absolute");
    const configuration: WebCodexConfiguration = {
      home: canonicalSessionPath(requested.home),
      command: await realpath(requested.command),
      pluginRoots: await Promise.all(requested.pluginRoots.map((root) => realpath(root))),
    };
    for (const gui of [
      this.environment.CODEX_HOME,
      this.environment.CODEXHOST_GUI_CODEX_HOME,
      path.join(this.environment.HOME ?? homedir(), ".codex"),
      path.join(homedir(), ".codex"),
    ]) {
      if (!gui) continue;
      const official = canonicalSessionPath(gui);
      const overlaps = (parent: string, child: string) => {
        const local = path.relative(parent, child);
        return (
          !local ||
          (local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local))
        );
      };
      if (overlaps(official, configuration.home) || overlaps(configuration.home, official))
        throw new Error("scope-conflict: GUI home overlap");
    }
    if (this.closed) throw new Error("owner-offline");
    if (requested.legacySource && !requested.migrateSource) {
      let legacyIndex: Record<string, unknown> | undefined;
      try {
        legacyIndex = JSON.parse(
          await readFile(
            path.join(requested.legacySource, "codex-sessions/sessions/index.json"),
            "utf8",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (legacyIndex && Object.keys(legacyIndex).length) {
        let commit: { sourceDataRoot?: string } | undefined;
        try {
          commit = JSON.parse(
            await readFile(path.join(this.root, "migration-commit-v1.json"), "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (commit?.sourceDataRoot !== canonicalSessionPath(requested.legacySource))
          throw new Error(
            "migration-required: Existing Web Codex sessions require --web-codex-migrate-source and --web-codex-legacy-stopped after verifying quiescence",
          );
      }
    }
    if (this.configuration) {
      if (JSON.stringify(configuration) !== JSON.stringify(this.configuration))
        throw new Error("scope-conflict");
      if (requested.migrateSource) {
        const commit = JSON.parse(
          await readFile(path.join(this.root, "migration-commit-v1.json"), "utf8"),
        ) as { sourceDataRoot?: string; nativeHome?: string };
        if (
          commit.sourceDataRoot !== canonicalSessionPath(requested.migrateSource) ||
          commit.nativeHome !== configuration.home
        )
          throw new Error("migration-source-conflict");
      }
      return this.description();
    }
    const scope = `web-codex:${createHash("sha256").update(configuration.home).digest("hex")}`;
    // Validate CLI/home isolation before creating any owner lock in that home.
    const harness = await createWebCodexHarness(
      configuration,
      this.environment,
      scope,
      this.preferencesRequest,
    );
    let ownership: SessionOwnership;
    try {
      const nativeExitProof = await readSharedHostExitProof(this.environment);
      ownership = await acquireSourceOwnerLock({
        root: this.root,
        home: configuration.home,
        ...(this.environment.CODEXHOST_SHARED_HOST_GENERATION
          ? {
              ownerGeneration: this.environment.CODEXHOST_SHARED_HOST_GENERATION,
            }
          : {}),
        ...(nativeExitProof ? { nativeExitProof } : {}),
      });
    } catch (error) {
      await harness.close();
      throw error;
    }
    try {
      if (this.closed) throw new Error("owner-offline");
      const recovery = await recoverSessionMigration(ownership);
      if (recovery === "rolled-back" && !requested.migrateSource)
        throw new Error("migration-rolled-back: Explicit source configuration required");
      if (requested.migrateSource) {
        if (!requested.legacyWriterStopped) throw new Error("legacy-writer-confirmation-required");
        await migrateLegacyWebSource({
          sourceDataRoot: requested.migrateSource,
          targetRoot: this.root,
          codexHome: configuration.home,
          legacyWriterStopped: true,
          ownership,
        });
      }
      if (this.closed) throw new Error("owner-offline");
      const organization: LocalSessionOrganization = new LocalSessionOrganization(
        ownership.data,
        (id): boolean => owner.owns(id),
      );
      const owner: IsolatedSessions = new IsolatedSessions(
        ownership.data,
        harness.harnesses,
        organization,
        {
          changed: (_kind, ...args) => {
            const first = args[0];
            const id =
              typeof first === "string"
                ? first
                : first && typeof first === "object" && "sessionId" in first
                  ? String(first.sessionId)
                  : undefined;
            this.events.webCodexChanged(scope, id);
          },
          interaction: (sessionId, interaction) => {
            const id = randomUUID();
            const completion = Promise.withResolvers<unknown>();
            this.pending.set(id, {
              sessionId,
              interaction,
              resolve: completion.resolve,
              reject: completion.reject,
            });
            this.events.webCodexChanged(scope, sessionId);
            return {
              result: completion.promise,
              cancel: () => {
                if (!this.pending.delete(id)) return;
                completion.reject(new Error("Interaction withdrawn"));
                this.events.webCodexChanged(scope, sessionId);
              },
            };
          },
        },
      );
      for (const id of owner.ids())
        if (await this.externalOwns(id)) throw new Error("session-source-collision");
      owner.notifier = (notification: SessionNotification) => {
        this.notifications.push({ sequence: ++this.notificationSequence, notification });
        if (this.notifications.length > 64) this.notifications.shift();
        this.events.webCodexChanged(scope, notification.sessionId);
      };
      organization.subscribe(() => this.events.webCodexChanged(scope));
      if (this.closed) {
        await owner.close();
        throw new Error("owner-offline");
      }
      ownership.data.writeConfiguration("service-config-v1.json", configuration);
      this.configuration = configuration;
      this.scope = scope;
      this.owner = owner;
      this.harness = harness;
      this.ownership = ownership;
      this.organization = organization;
      this.events.webCodexChanged(scope);
      return this.description();
    } catch (error) {
      await harness?.close();
      await ownership.release();
      throw error;
    }
  }
  private description(): WebCodexConfigurationReply {
    if (!this.scope || !this.owner) throw new Error("owner-offline");
    return {
      version: 1,
      scope: this.scope,
      cursor: this.events.cursor,
      sessionIds: [...this.owner.ids()],
      notificationCursor: this.notificationSequence,
    };
  }
  private validate(epoch: string, scope: string): IsolatedSessions {
    if (this.closed || !this.owner) throw new Error("owner-offline");
    if (epoch !== this.events.epoch) throw new Error("owner-epoch-obsolete");
    if (scope !== this.scope) throw new Error("scope-unknown");
    return this.owner;
  }
  async request(input: unknown): Promise<unknown> {
    const request = webCodexRequestSchema.parse(input);
    const owner = this.validate(request.epoch, request.address.scope);
    const args = request.input;
    if (args.request !== undefined || args._request !== undefined)
      throw new Error("request-envelope-invalid");
    const id = request.address.sessionId;
    if (sessionOperations.has(request.operation) && (!id || !owner.owns(id)))
      throw new Error("session-not-found");
    if (id && !["create", "prepareDraft"].includes(request.operation) && !owner.owns(id))
      throw new Error("session-not-found");
    for (const key of ["sessionId", "agentId"])
      if (args[key] !== undefined && args[key] !== id) throw new Error("session-address-mismatch");
    if (args.nativeRef !== undefined || args.home !== undefined || args.adapter !== undefined)
      throw new Error("scope-conflict");
    if (
      (args.harnessId !== undefined && args.harnessId !== "codex") ||
      (args.provider !== undefined && args.provider !== "codex")
    )
      throw new Error("scope-conflict");
    const addressed = { ...args, ...(id ? { sessionId: id, agentId: id } : {}) };
    switch (request.operation) {
      case "list":
        return owner.list();
      case "modelCatalog":
        return owner.modelCatalog();
      case "inspect":
        if (!this.harness) throw new Error("owner-offline");
        return this.harness.harnesses.inspect("codex");
      case "create":
      case "prepareDraft": {
        if (id && !owner.owns(id) && !/^draft-[0-9a-f-]{36}$/u.test(id))
          throw new Error("session-address-invalid");
        if (id && (await this.externalOwns(id))) throw new Error("session-source-collision");
        if (request.operation === "create") return owner.createRequest(addressed);
        const configuration = args.configuration as Parameters<IsolatedSessions["prepareDraft"]>[1];
        if (configuration?.selection?.provider !== "codex") throw new Error("scope-conflict");
        if (!id) throw new Error("session-address-required");
        return owner.prepareDraft(
          { sessionId: id, ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}) },
          configuration,
        );
      }
      case "selectModel":
        return owner.selectModel(addressed);
      case "prompt": {
        if (typeof args.requestId !== "string" || !args.requestId)
          throw new Error("request-id-required");
        const key = JSON.stringify([id, args.requestId]);
        const signature = JSON.stringify(addressed);
        const existing = this.receipts.get(key);
        if (existing) {
          if (existing.signature !== signature) throw new Error("request-id-conflict");
          return existing.result;
        }
        if (this.receipts.size >= 256) {
          const retired = [...this.receipts].find(([, receipt]) => receipt.settled)?.[0];
          if (!retired) throw new Error("session-busy: Too many pending submissions");
          this.receipts.delete(retired);
        }
        const result = owner.prompt(addressed);
        const receipt = { signature, result, settled: false };
        this.receipts.set(key, receipt);
        void result.then(
          () => {
            receipt.settled = true;
          },
          () => {
            receipt.settled = true;
          },
        );
        return result;
      }
      case "cancel":
        return owner.cancel(addressed);
      case "updateQueue":
        return owner.updateQueue(addressed);
      case "rename":
        return owner.rename(addressed);
      case "fork":
        return owner.forkRequest(addressed);
      case "search":
        return owner.search(addressed);
      case "page": {
        const address = args.address as Record<string, unknown> | undefined;
        if (
          (address?.sessionId && address.sessionId !== id) ||
          (address?.childSessionId && address.childSessionId !== id)
        )
          throw new Error("session-address-mismatch");
        return owner.page({ ...addressed, address: { ...address, sessionId: id } });
      }
      case "projections":
        return owner.projections(addressed);
      case "listCommands":
        return owner.commandsList(addressed);
      case "executeCommand":
        return owner.commandsExecute(addressed);
      case "permissionCatalog":
        return owner.permissionCatalogRequest(addressed);
      case "notifications":
        return {
          cursor: this.notificationSequence,
          items: this.notifications.filter((value) => value.sequence > Number(args.after ?? 0)),
        };
      case "importSources":
        return owner.importSources();
      case "importCandidates":
        return owner.importCandidatesRequest({ ...args, harnessId: "codex" });
      case "import":
        return owner.importNativeRequest({ ...args, harnessId: "codex" });
      case "interactions":
        return [...this.pending].map(([requestId, value]) => ({
          requestId,
          sessionId: value.sessionId,
          interaction: value.interaction,
        }));
      case "respond": {
        const pending = this.pending.get(String(args.requestId));
        if (!pending) return { resolved: false };
        if (!id || pending.sessionId !== id || !owner.owns(id))
          throw new Error("interaction-source-mismatch");
        this.pending.delete(String(args.requestId));
        pending.resolve(args.result);
        this.events.webCodexChanged(request.address.scope, id);
        return { resolved: true };
      }
      case "organization":
        return this.organizationRequest(args, id);
    }
  }
  private organizationRequest(args: Record<string, unknown>, id: string | undefined): unknown {
    const organization = this.organization;
    if (!organization) throw new Error("owner-offline");
    const requireId = () => {
      if (!id) throw new Error("session-address-required");
      return id;
    };
    switch (args.action) {
      case "snapshot":
        return organization.snapshot();
      case "create":
        return organization.create(String(args.path));
      case "rename":
        return organization.rename(String(args.workspaceId), String(args.title));
      case "delete":
        return organization.delete(String(args.workspaceId));
      case "insertBefore":
        return organization.insertBefore(
          String(args.workspaceId),
          typeof args.before === "string" ? args.before : undefined,
        );
      case "insertSessionBefore":
        return organization.insertSessionBefore(
          String(args.workspaceId),
          requireId(),
          typeof args.before === "string" ? args.before : undefined,
        );
      case "archive":
        return organization.setArchived(requireId(), true);
      case "unarchive":
        return organization.setArchived(requireId(), false);
      case "pin":
        return organization.setPinned(requireId(), true);
      case "unpin":
        return organization.setPinned(requireId(), false);
      default:
        throw new Error("unsupported");
    }
  }
  stream(input: unknown, sink: SessionSink): void {
    const request = webCodexStreamRequestSchema.parse(input);
    const owner = this.validate(request.epoch, request.address.scope);
    if (request.input.request !== undefined || request.input._request !== undefined)
      throw new Error("request-envelope-invalid");
    if (request.stream === "control") {
      owner.control({}, sink);
      return;
    }
    const id = request.address.sessionId;
    if (!id || !owner.owns(id)) throw new Error("session-not-found");
    const address = request.input.address as Record<string, unknown> | undefined;
    if (
      (address?.sessionId && address.sessionId !== id) ||
      (address?.childSessionId && address.childSessionId !== id)
    )
      throw new Error("session-address-mismatch");
    owner.follow({ ...request.input, address: { ...address, sessionId: id } }, sink);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return (this.closing = (async () => {
      await this.configuring?.catch(() => {});
      for (const pending of this.pending.values()) pending.reject(new Error("Owner stopped"));
      this.pending.clear();
      await this.owner?.close();
      await this.harness?.close();
      await this.ownership?.release();
    })());
  }
}
