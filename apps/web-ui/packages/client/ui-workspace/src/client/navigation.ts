/** Workspace archive and directory UI capability. */

import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  ClientRemote,
  DirectoryListing,
  RemoteFailure,
} from "@deepseek-ai/dsh-api-remotes/client";
import type {
  ISessions,
  SessionCreateError,
  SessionReference,
  SessionTarget,
  SessionListState,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { createSnapshotStore, type ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";
import type {
  IWorkspaces,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceView,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { DraftInitializationOptions } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { RowToast } from "./contract/slots.ts";
import { pinOrderAccounts, pinOrderSource } from "./pin-order.ts";
import type { WorkspaceViewStoreActions } from "./stores.ts";
import { SessionKeepalive } from "./session-keepalive.ts";
import { RecentVisits } from "./recent-visits.ts";

interface MainSelection {
  readonly sessionId?: SessionId;
  readonly subagentAddress?: SubagentAddress;
}

/** Optional content preparation for the resolved target Session. */
export type StartSessionOptions = DraftInitializationOptions;

/** Local target resolution; it is independent of sidebar and configuration loading. */
export type SessionOpeningState =
  | { readonly state: "idle" }
  | { readonly state: "loading"; readonly sessionId: SessionId }
  | { readonly state: "error"; readonly sessionId: SessionId; readonly message: string };

/** Classified failure categories for New Session creation on the Hero surface. */
export type SessionCreationFailureReason = "no-harness" | "workspace-required" | "unknown";

/** Pending or failed New Session creation displayed immediately on the Hero surface. */
export type SessionCreationState =
  | { readonly state: "idle" }
  | {
      readonly state: "creating";
      readonly workspaceId: WorkspaceId | null;
      readonly token: number;
      readonly initialPrompt?: string;
    }
  | {
      readonly state: "error";
      readonly workspaceId: WorkspaceId | null;
      readonly reason: SessionCreationFailureReason;
      readonly message?: string;
      readonly token: number;
      readonly initialPrompt?: string;
    };

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * Unknown IDs resolve through their own summary read; failures surface in `opening`.
   * @param target - Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void;
  /** Current ID-resolution progress or failure, not conversation-history readiness. */
  readonly opening: ObservableSnapshot<SessionOpeningState>;
  /** Retry only the current failed target; never resubmit a write. */
  retryOpening(): void;
  /** Current New Session creation progress or failure on the Hero surface. */
  readonly creating: ObservableSnapshot<SessionCreationState>;
  /** Retry the current failed New Session creation while keeping the user's draft. */
  retryCreating(): void;
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session,
   * skipped after supersession; a throw aborts the open and releases the retained reference.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(
    workspaceId: WorkspaceId | null,
    beforeOpen?: (sessionId: SessionId) => void,
  ): Promise<void>;
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @param onCreated - observer before the optional child-title update.
   * @returns the child SessionId after creation and inherited-title increment.
   */
  forkSession(sessionId: SessionId, onCreated?: (childId: SessionId) => void): Promise<SessionId>;
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>;
  /**
   * Start a New Session flow and navigate to its Session; a creation the Host
   * refuses is shown through the Workspace notice and leaves the selection as it was.
   * @param workspaceId - explicit target; shared mode defaults to no project, standalone inherits a Workspace.
   * @param options - initial content; existing text or attachments are preserved unless clearPreviousDraft is true.
   */
  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void;
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(
    sessionId: SessionId,
    options?: { readonly stopActivity?: boolean },
  ): Promise<void>;
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>;
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>;
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>;
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>;
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>;
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace;
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = "DirectoryBrowseError";

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`);
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>();
  private readonly lifetime = new AbortController();
  private readonly selection = createSnapshotStore<MainSelection>(
    {},
    { persist: { name: "dsh.sessions.current" } },
  );
  private mainReference: SessionReference | undefined;
  private mainIsRemote = false;
  private disposeMainSessionWatch: (() => void) | undefined;
  readonly opening = createSnapshotStore<SessionOpeningState>({ state: "idle" });
  private retryOpen: (() => void) | undefined;
  private openingLoad: { readonly stop: () => void } | undefined;
  readonly creating = createSnapshotStore<SessionCreationState>({ state: "idle" });
  private retryCreate: (() => void) | undefined;
  private creatingLoad: { readonly stop: () => void } | undefined;
  private creationToken = 0;
  /** The projectless blank last opened in the main view; abandoned creations never set it. */
  private openedProjectlessBlank: SessionId | undefined;
  private readonly keepalive: SessionKeepalive;
  /** Stable browser tab order; does not own Session references. */
  readonly recentVisits: RecentVisits;

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote["directoryPicker"],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, "pinSessionOrder">,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, "uiWorkspace");
    this.keepalive = new SessionKeepalive(sessions, workspaces);
    const remote = ctx.get("remote");
    this.recentVisits = new RecentVisits(
      sessions,
      workspaces,
      remote === undefined ? undefined : (listener) => remote.$on("api-session/removed", listener),
      () => notify({ kind: "recentVisitsStorageFailed" }),
    );
    ctx.effect(() => {
      const saved = this.selection.getSnapshot();
      const stopVisits = this.recentVisits.start(
        saved.subagentAddress?.childSessionId ?? saved.sessionId,
      );
      const stopKeepalive = this.keepalive.start();
      const stop = this.watchNavigation();
      return () => {
        stop();
        this.lifetime.abort();
        stopKeepalive();
        stopVisits();
        this.disposeMainSessionWatch?.();
        this.disposeMainSessionWatch = undefined;
        const reference = this.mainReference;
        this.mainReference = undefined;
        this.mainIsRemote = false;
        reference?.release();
      };
    }, "ui-workspace: Workspace navigation policy");
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list
      .getSnapshot()
      .items.find((item) => item.workspaceId === workspaceId);
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);
    }
    const inflight = this.connecting.get(workspaceId);
    if (inflight !== undefined) return inflight;

    const attempt = this.reuseOrCreateBlank(workspace).finally(() => {
      this.connecting.delete(workspaceId);
    });
    this.connecting.set(workspaceId, attempt);
    return attempt;
  }

  private reuseOrCreateBlank(workspace: WorkspaceView): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds;
    const sessions = this.sessions.list.getSnapshot();
    for (const id of sessions.ids) {
      const summary = sessions.byId[id];
      if (
        summary === undefined ||
        !summary.blank ||
        summary.cwd !== workspace.path ||
        !workspace.sessionIds.includes(id) ||
        archived.includes(id)
      )
        continue;
      return this.reuseBlank(workspace.workspaceId, id);
    }
    return this.sessions.create({ workspaceId: workspace.workspaceId });
  }

  /**
   * Resolve the blank Session for a New Session without a project. Reusing the
   * existing projectless blank keeps its unsent composer draft, which is
   * persisted per Session and unreachable once a fresh blank replaces it.
   */
  private reuseOrCreateProjectlessBlank(): Promise<SessionId> {
    const workspaces = this.workspaces.list.getSnapshot();
    const sessions = this.sessions.list.getSnapshot();
    const reusable = (id: SessionId): boolean => {
      const summary = sessions.byId[id];
      return (
        summary !== undefined &&
        summary.blank &&
        summary.cwd === undefined &&
        summary.parentId === undefined &&
        summary.origin === undefined &&
        !this.isRemoteSession(id) &&
        !workspaces.archivedSessionIds.includes(id) &&
        !workspaces.items.some((workspace) => workspace.sessionIds.includes(id))
      );
    };
    // An abandoned concurrent creation can leave an earlier-listed blank; the opened one holds the draft.
    const opened = this.openedProjectlessBlank;
    const id = opened !== undefined && reusable(opened) ? opened : sessions.ids.find(reusable);
    return id === undefined ? this.sessions.create() : this.reuseBlank(undefined, id);
  }

  /** Open a projectless blank in the main view and remember it for the next New Session. */
  private openProjectlessBlank(
    sessionId: SessionId,
    navigation: AbortSignal,
    panel: "reveal" | "preserve",
    beforeOpen?: (sessionId: SessionId) => void,
    preserveSavedSelection = false,
  ): void {
    this.replaceMain(sessionId, navigation, panel, beforeOpen, preserveSavedSelection);
    if (this.mainReference?.sessionId === sessionId) this.openedProjectlessBlank = sessionId;
  }

  private async reuseBlank(
    workspaceId: WorkspaceId | undefined,
    sessionId: SessionId,
  ): Promise<SessionId> {
    const scope = workspaceId === undefined ? {} : { workspaceId };
    try {
      return await this.sessions.create({ ...scope, sessionId });
    } catch (error: unknown) {
      // The CH Host's `session/busy` is not in the client's declared error map; compare as text.
      const code: string | undefined = sessionCreateErrorOf(error)?.rpcError.code;
      // A projectless blank that began submitting reports busy; start a fresh one instead.
      if (code !== "session/writer-held" && !(workspaceId === undefined && code === "session/busy"))
        throw error;
      return this.sessions.create(scope);
    }
  }

  openSession(target: SessionTarget): void {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    this.opening.set({ state: "idle" });
    this.retryOpen = undefined;
    if (typeof target !== "string" || this.sessions.list.getSnapshot().byId[target] !== undefined) {
      this.replaceMain(target, navigation, "reveal");
      return;
    }
    void this.resolveSession(
      target,
      navigation,
      () => {
        this.replaceMain(target, navigation, "reveal");
      },
      () => this.openSession(target),
    );
  }

  /** Remove only the tab entry; keep the current conversation and navigation unchanged. */
  closeSessionTab(sessionId: SessionId): void {
    this.recentVisits.close(sessionId);
  }

  /** Remove all tab entries without changing the current conversation or navigation. */
  closeAllSessionTabs(): void {
    this.recentVisits.closeAll();
  }

  retryOpening(): void {
    this.retryOpen?.();
  }

  retryCreating(): void {
    this.retryCreate?.();
  }

  private async resolveSession(
    sessionId: SessionId,
    signal: AbortSignal,
    resolved: () => void,
    retry: () => void,
    onMissing?: (offline?: { readonly message: string }) => void,
  ): Promise<void> {
    if (signal.aborted) return;
    this.openingLoad?.stop();
    this.retryOpen = undefined;
    // Cordis traces function-valued service properties; a plain holder preserves request identity.
    const load = { stop: (): void => signal.removeEventListener("abort", clear) };
    const clear = (): void => {
      load.stop();
      if (this.openingLoad !== load) return;
      this.openingLoad = undefined;
      this.opening.set({ state: "idle" });
      this.retryOpen = undefined;
    };
    signal.addEventListener("abort", clear, { once: true });
    this.openingLoad = load;
    this.opening.set({ state: "loading", sessionId });
    try {
      if (signal.aborted || this.openingLoad !== load) return;
      await this.sessions.loadSummary(sessionId);
      if (signal.aborted || this.openingLoad !== load) return;
      if (this.sessions.list.getSnapshot().byId[sessionId] === undefined) {
        if (onMissing !== undefined) {
          clear();
          onMissing();
          return;
        }
        throw new Error(`Session not found: ${sessionId}`);
      }
      resolved();
      clear();
    } catch (error: unknown) {
      if (signal.aborted || this.openingLoad !== load) return;
      const offline = remoteFailureCode(error) === "remote/offline";
      if (onMissing !== undefined && (offline || isMissingSessionError(error))) {
        clear();
        onMissing(offline ? { message: creationFailureMessage(error) } : undefined);
        return;
      }
      this.retryOpen = retry;
      this.opening.set({ state: "error", sessionId, message: creationFailureMessage(error) });
    }
  }

  async openWorkspace(
    workspaceId: WorkspaceId | null,
    beforeOpen?: (sessionId: SessionId) => void,
  ): Promise<void> {
    if (this.mainReference === undefined) {
      const current = this.creating.getSnapshot();
      const token = current.state === "idle" ? ++this.creationToken : current.token;
      const initialPrompt = current.state === "idle" ? undefined : current.initialPrompt;
      await this.runCreation({
        workspaceId,
        token,
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(beforeOpen === undefined ? {} : { beforeOpen }),
      });
      return;
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    let sessionId: SessionId;
    try {
      if (workspaceId === null && !this.workspaces.list.getSnapshot().canStartProjectless)
        throw new WorkspaceRequiredError();
      sessionId =
        workspaceId === null
          ? await this.reuseOrCreateProjectlessBlank()
          : await this.connectWorkspace(workspaceId);
    } catch (error: unknown) {
      // Reported here, not in connectWorkspace: startup restoration calls that
      // directly and stays console-only.
      if (!navigation.aborted)
        this.notify({ kind: "createFailed", message: creationFailureMessage(error) });
      throw error;
    }
    if (navigation.aborted) return;
    if (workspaceId === null)
      this.openProjectlessBlank(sessionId, navigation, "reveal", beforeOpen);
    else this.replaceMain(sessionId, navigation, "reveal", beforeOpen);
  }

  async forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
  ): Promise<SessionId> {
    return this.sessions.fork({
      sessionId,
      increaseTitle: true,
      ...(onCreated === undefined ? {} : { onCreated }),
    });
  }

  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void {
    const draftOptions = options === undefined ? undefined : { ...options };
    const initializeDraft =
      draftOptions !== undefined &&
      (draftOptions.prompt !== undefined || draftOptions.clearPreviousDraft === true);
    const workspace = this.workspaces.list.getSnapshot();
    const sessions = this.sessions.list.getSnapshot();
    const current = this.mainReference?.sessionId;
    const currentWorkspaceId =
      current === undefined
        ? undefined
        : workspace.items.find((item) => item.sessionIds.includes(current))?.workspaceId;
    const recent =
      workspace.phase === "ready" && sessions.phase === "ready"
        ? recentWorkspace(workspace.items, sessions.byId)
        : undefined;
    const target =
      workspaceId ?? (workspace.canStartProjectless ? null : (currentWorkspaceId ?? recent));
    if (target === undefined) {
      // An explicit New Session supersedes an ID lookup even when no project can be chosen yet.
      this.ctx.layout.beginNavigation();
      if (initializeDraft) {
        this.notify({
          kind: "createFailed",
          message: this.ctx.locale.bind("workspace")("draft.workspaceRequired"),
        });
        return;
      }
      this.clearMain();
      return;
    }
    // Reveal the Conversation Hero immediately before creating the navigation signal;
    // selectPanel aborts any earlier pending navigation.
    this.ctx.layout.selectPanel(null);
    this.releaseMainSelection();
    const token = ++this.creationToken;
    void this.runCreation({
      workspaceId: target,
      token,
      ...(draftOptions?.prompt === undefined ? {} : { initialPrompt: draftOptions.prompt }),
      ...(initializeDraft ? { draftOptions } : {}),
    }).catch((reason: unknown) => {
      console.warn("new session failed:", reason);
    });
  }

  private async runCreation(request: {
    readonly workspaceId: WorkspaceId | null;
    readonly token: number;
    readonly initialPrompt?: string;
    readonly draftOptions?: DraftInitializationOptions;
    readonly beforeOpen?: (sessionId: SessionId) => void;
  }): Promise<void> {
    // Disarm any prior creation abort listener before beginNavigation so a retry
    // or in-place workspace switch transitions directly without flashing `idle`
    // and discarding the user's pending draft.
    this.creatingLoad?.stop();
    this.creatingLoad = undefined;
    this.retryCreate = undefined;
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    this.openingLoad?.stop();
    this.openingLoad = undefined;
    this.opening.set({ state: "idle" });
    this.retryOpen = undefined;

    const load = { stop: (): void => navigation.removeEventListener("abort", clear) };
    const clear = (): void => {
      load.stop();
      if (this.creatingLoad !== load) return;
      this.creatingLoad = undefined;
      this.retryCreate = undefined;
      this.creating.set({ state: "idle" });
    };
    navigation.addEventListener("abort", clear, { once: true });
    this.creatingLoad = load;
    this.creating.set({
      state: "creating",
      workspaceId: request.workspaceId,
      token: request.token,
      ...(request.initialPrompt === undefined ? {} : { initialPrompt: request.initialPrompt }),
    });

    try {
      if (request.workspaceId === null && !this.workspaces.list.getSnapshot().canStartProjectless) {
        throw new WorkspaceRequiredError();
      }
      const sessionId =
        request.workspaceId === null
          ? await this.reuseOrCreateProjectlessBlank()
          : await this.connectWorkspace(request.workspaceId);
      if (navigation.aborted || this.creatingLoad !== load) return;
      const beforeOpen = (id: SessionId): void => {
        request.beforeOpen?.(id);
        this.handoffPendingDraft(id, request.draftOptions);
      };
      if (request.workspaceId === null)
        this.openProjectlessBlank(sessionId, navigation, "preserve", beforeOpen);
      else this.replaceMain(sessionId, navigation, "preserve", beforeOpen);
      clear();
    } catch (error: unknown) {
      if (navigation.aborted || this.creatingLoad !== load) return;
      this.retryCreate = () => {
        void this.runCreation(request).catch((reason: unknown) => {
          console.warn("new session retry failed:", reason);
        });
      };
      const reason = classifyCreationFailure(error);
      const message = reason === "unknown" ? creationFailureDetail(error) : undefined;
      this.creating.set({
        state: "error",
        workspaceId: request.workspaceId,
        reason,
        ...(message === undefined ? {} : { message }),
        token: request.token,
        ...(request.initialPrompt === undefined ? {} : { initialPrompt: request.initialPrompt }),
      });
      throw error;
    }
  }

  private handoffPendingDraft(
    sessionId: SessionId,
    draftOptions?: DraftInitializationOptions,
  ): void {
    const binding = this.sessions.binding(sessionId);
    const conversation = this.ctx.get("conversation");
    if (draftOptions !== undefined) {
      if (binding === undefined || conversation === undefined) this.draftPreparationFailed();
      if (conversation.input.adoptPendingDraft(binding, draftOptions) === "blocked") {
        this.draftPreparationFailed();
      }
      return;
    }
    if (binding !== undefined && conversation !== undefined) {
      conversation.input.adoptPendingDraft(binding);
    }
  }

  private draftPreparationFailed(): never {
    const message = this.ctx.locale.bind("workspace")("draft.initializationFailed");
    this.notify({ kind: "createFailed", message });
    throw new Error(message);
  }

  async archiveSession(
    sessionId: SessionId,
    options: { readonly stopActivity?: boolean } = {},
  ): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options);
    if (this.mainReference?.sessionId === sessionId) this.clearMain();
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId);
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId);
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot();
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), {
        pinnedSessionIds,
        archivedSessionIds,
      }),
    );
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId);
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick();
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`);
    return result.value;
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal);
    if (!result.ok) throw new DirectoryBrowseError(result.error);
    return result.value;
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name);
    if (!result.ok) throw new DirectoryBrowseError(result.error);
    return result.value;
  }

  private watchNavigation(): () => void {
    let initial: "waiting" | "connecting" | "done" = "waiting";
    let savedRemoteOffline:
      | { readonly sessionId: SessionId; readonly message: string; readonly retry: () => void }
      | undefined;
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
    // Explicit navigation supersedes startup, including an unresolved direct link.
    navigation.addEventListener(
      "abort",
      () => {
        initial = "done";
      },
      { once: true },
    );
    const showOfflineRecovery = (offline: {
      readonly sessionId: SessionId;
      readonly message: string;
      readonly retry: () => void;
    }): void => {
      this.retryOpen = offline.retry;
      this.opening.set({
        state: "error",
        sessionId: offline.sessionId,
        message: offline.message,
      });
    };
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return;
      const current = this.mainReference?.sessionId;
      if (current !== undefined && !this.mainIsRemote && this.isRemoteSession(current)) {
        this.mainIsRemote = true;
      }
      if (this.clearArchivedCurrent() || this.clearRemovedRemoteCurrent()) return;
      if (initial !== "waiting") return;
      const workspace = this.workspaces.list.getSnapshot();
      const sessions = this.sessions.list.getSnapshot();
      if (this.mainReference !== undefined) {
        initial = "done";
        return;
      }
      if (workspace.phase !== "ready" || sessions.phase !== "ready") return;
      initial = "connecting";
      const offlineFallback = savedRemoteOffline;
      void this.restoreSelection(
        workspace,
        sessions,
        navigation,
        offlineFallback !== undefined,
      ).then(
        (restored) => {
          if (navigation.aborted) return;
          if (!restored && offlineFallback !== undefined && this.mainReference === undefined) {
            showOfflineRecovery(offlineFallback);
          }
          initial = "done";
        },
        (reason: unknown) => {
          if (navigation.aborted) return;
          if (offlineFallback !== undefined && this.mainReference === undefined) {
            showOfflineRecovery(offlineFallback);
            initial = "done";
            console.warn("initial Session restoration failed:", reason);
            return;
          }
          initial = "waiting";
          console.warn("initial Session restoration failed:", reason);
        },
      );
    };

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile);
    const disposeSessions = this.sessions.list.subscribe(reconcile);
    const remote = this.ctx.get("remote");
    const disposeRemoved = remote?.$on("api-session/removed", (sessionId: SessionId) => {
      if (this.lifetime.signal.aborted) return;
      this.clearRemovedRemoteCurrent(sessionId);
    });
    const saved = this.selection.getSnapshot();
    if (saved.sessionId !== undefined || saved.subagentAddress !== undefined) {
      initial = "connecting";
      if (saved.subagentAddress !== undefined) {
        this.replaceMain(saved.subagentAddress, navigation, "preserve");
        initial = "done";
      } else if (saved.sessionId !== undefined) {
        const id = saved.sessionId;
        const restore = (): void => {
          void this.resolveSession(
            id,
            navigation,
            () => {
              savedRemoteOffline = undefined;
              if (this.sessions.list.getSnapshot().byId[id]?.blank === true) {
                // Reusing a draft still needs authoritative Workspace membership/writer checks.
                initial = "waiting";
                reconcile();
              } else {
                this.replaceMain(id, navigation, "preserve");
                initial = "done";
              }
            },
            restore,
            (offline) => {
              if (navigation.aborted) return;
              if (offline === undefined && this.selection.getSnapshot().sessionId === id) {
                this.selection.set({});
              }
              savedRemoteOffline =
                offline === undefined
                  ? undefined
                  : { sessionId: id, message: offline.message, retry: restore };
              initial = "waiting";
              reconcile();
            },
          );
        };
        restore();
      }
    }
    reconcile();
    return () => {
      this.lifetime.abort();
      disposeRemoved?.();
      disposeSessions();
      disposeWorkspaces();
    };
  }

  private async restoreSelection(
    workspaces: WorkspaceSnapshot,
    sessions: SessionListState,
    navigation: AbortSignal,
    savedRemoteOffline: boolean,
  ): Promise<boolean> {
    const saved: MainSelection = savedRemoteOffline ? {} : this.selection.getSnapshot();
    const workspaceItems = savedRemoteOffline
      ? workspaces.items.filter((item) => item.remote === undefined)
      : workspaces.items;
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, navigation, "preserve");
      return true;
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId];
    const workspace =
      summary === undefined
        ? undefined
        : workspaceItems.find((item) => item.sessionIds.includes(summary.id));
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      if (summary.blank) this.openProjectlessBlank(summary.id, navigation, "preserve");
      else this.replaceMain(summary.id, navigation, "preserve");
      return true;
    }
    let sessionId: SessionId | undefined;
    if (
      summary !== undefined &&
      workspace !== undefined &&
      summary.cwd === workspace.path &&
      !workspaces.archivedSessionIds.includes(summary.id)
    ) {
      sessionId = await this.reuseBlank(workspace.workspaceId, summary.id);
    }
    if (sessionId === undefined && workspaces.canStartProjectless && summary === undefined) {
      sessionId = await this.reuseOrCreateProjectlessBlank();
      if (!navigation.aborted) {
        this.openProjectlessBlank(sessionId, navigation, "preserve", undefined, savedRemoteOffline);
        return true;
      }
      return false;
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaceItems, sessions.byId);
    const hasLocalSessions = sessions.ids.some(
      (id) => !workspaces.archivedSessionIds.includes(id) && !this.isRemoteSession(id),
    );
    if (
      target === undefined &&
      workspaceItems.length === 0 &&
      (savedRemoteOffline ? !hasLocalSessions : sessions.ids.length === 0)
    ) {
      const prepared = await this.initializeDefaultWorkspace(navigation);
      if (navigation.aborted) return false;
      target = prepared?.workspaceId;
    }
    if (sessionId === undefined && target !== undefined)
      sessionId = await this.connectWorkspace(target);
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, "preserve", undefined, savedRemoteOffline);
      return true;
    }
    return false;
  }

  private async initializeDefaultWorkspace(
    signal: AbortSignal,
  ): Promise<WorkspaceView | undefined> {
    try {
      return await this.workspaces.initializeDefault(signal);
    } catch (_error: unknown) {
      if (!signal.aborted) this.notify({ kind: "defaultWorkspaceFailed" });
      return undefined;
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId;
    if (
      current === undefined ||
      !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)
    )
      return false;
    this.clearMain();
    return true;
  }

  private isDurableSubagent(sessionId: SessionId): boolean {
    return (
      this.sessions.subagentAddress(sessionId) !== undefined ||
      this.sessions.list.getSnapshot().byId[sessionId]?.origin === "subagent"
    );
  }

  private isRemoteSession(sessionId: SessionId): boolean {
    const list = this.sessions.list.getSnapshot();
    const workspaces = this.workspaces.list.getSnapshot().items;
    const seen = new Set<SessionId>();
    let cursor: SessionId | undefined = sessionId;
    while (cursor !== undefined && !seen.has(cursor)) {
      const id: SessionId = cursor;
      seen.add(id);
      if (
        id.startsWith("web-remote:") ||
        list.byId[id]?.projectionValues?.remoteHost != null ||
        list.projectionsBySession[id]?.values.remoteHost != null ||
        workspaces.some(
          (workspace) => workspace.remote !== undefined && workspace.sessionIds.includes(id),
        )
      ) {
        return true;
      }
      cursor = this.sessions.subagentAddress(id)?.parentSessionId;
    }
    return false;
  }

  /** @returns true when an explicitly removed remote current selection was cleared. */
  private clearRemovedRemoteCurrent(explicitRemovedId?: SessionId): boolean {
    const current = this.mainReference;
    if (current === undefined) return false;
    if (explicitRemovedId !== undefined && this.isDurableSubagent(explicitRemovedId)) {
      return false;
    }

    const seen = new Set<SessionId>();
    let cursor: SessionId | undefined = current.sessionId;
    let matchedRemoval = false;
    while (cursor !== undefined && !seen.has(cursor)) {
      const id: SessionId = cursor;
      seen.add(id);
      const binding = id === current.sessionId ? current.binding : this.sessions.binding(id);
      if (
        (explicitRemovedId !== undefined && id === explicitRemovedId) ||
        binding?.session.getSnapshot().removed === true
      ) {
        matchedRemoval = true;
        break;
      }
      cursor = this.sessions.subagentAddress(id)?.parentSessionId;
    }
    if (!matchedRemoval) return false;

    const isRemote =
      this.mainIsRemote ||
      this.isRemoteSession(current.sessionId) ||
      (explicitRemovedId !== undefined && this.isRemoteSession(explicitRemovedId));
    if (!isRemote) return false;

    this.clearMain();
    return true;
  }

  private releaseMainSelection(): void {
    const previous = this.mainReference;
    this.disposeMainSessionWatch?.();
    this.disposeMainSessionWatch = undefined;
    this.mainReference = undefined;
    this.mainIsRemote = false;
    this.recentVisits.clearCurrent();
    this.selection.set({});
    previous?.release();
  }

  private clearMain(): void {
    this.releaseMainSelection();
    this.ctx.layout.selectPanel(null);
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: "reveal" | "preserve",
    beforeOpen?: (sessionId: SessionId) => void,
    preserveSavedSelection = false,
  ): void {
    signal.throwIfAborted();
    const reference = this.sessions.retain(target, { source: "mainView" });
    try {
      signal.throwIfAborted();
      beforeOpen?.(reference.sessionId);
      if (signal.aborted) {
        reference.release();
        return;
      }
      if (!preserveSavedSelection) {
        const subagentAddress =
          typeof target === "string" ? this.sessions.subagentAddress(reference.sessionId) : target;
        this.selection.set({
          sessionId: reference.sessionId,
          ...(subagentAddress === undefined ? {} : { subagentAddress }),
        });
      }
    } catch (error: unknown) {
      reference.release();
      throw error;
    }
    const previous = this.mainReference;
    this.disposeMainSessionWatch?.();
    this.disposeMainSessionWatch = undefined;
    this.mainReference = reference;
    this.mainIsRemote = this.isRemoteSession(reference.sessionId);
    this.disposeMainSessionWatch =
      typeof reference.binding.session.subscribe === "function"
        ? reference.binding.session.subscribe(() => {
            if (!this.lifetime.signal.aborted) this.clearRemovedRemoteCurrent();
          })
        : undefined;
    this.keepalive.visit(reference, target);
    this.recentVisits.visit(reference.sessionId, target);
    previous?.release();
    if (panel === "reveal") this.ctx.layout.selectPanel(null);
  }
}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === "SessionCreateError"
    ? (error as SessionCreateError)
    : undefined;
}

function remoteFailureCode(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "isDSHRemoteError" in error &&
    error.isDSHRemoteError === true &&
    "code" in error
  )
    return error.code;
}

function isMissingSessionError(error: unknown): boolean {
  const code = remoteFailureCode(error);
  return (
    code === "session/not-found" ||
    code === "remote/not-found" ||
    code === "remote/identity-invalid"
  );
}

class WorkspaceRequiredError extends Error {
  override readonly name = "WorkspaceRequiredError";

  constructor() {
    super("This Host requires a Workspace.");
  }
}

/** Map a creation failure to a product-facing failure category without leaking wire codes. */
function classifyCreationFailure(error: unknown): SessionCreationFailureReason {
  const refused = sessionCreateErrorOf(error);
  const code: string | undefined = refused?.rpcError.code;
  if (code === "host/no-harness") return "no-harness";
  if (error instanceof WorkspaceRequiredError) return "workspace-required";
  return "unknown";
}

/** Extract a clean failure detail without wire-code prefixes for unknown creation errors. */
function creationFailureDetail(error: unknown): string | undefined {
  const refused = sessionCreateErrorOf(error);
  const raw =
    refused !== undefined
      ? refused.rpcError.message
      : error instanceof Error
        ? error.message
        : String(error);
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error);
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState["byId"],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId];
      if (session !== undefined) latest = Math.max(latest, session.updatedAt);
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId;
      selectedTime = latest;
    }
  }
  return selected;
}

export { UiWorkspaceService };
