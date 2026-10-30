import {
  THREAD_QUESTION_RESPOND_METHOD,
  threadQuestionsListParamsSchema,
  threadQuestionRespondParamsSchema,
  DELEGATION_READ_METHOD,
  delegationReadParamsSchema,
  EXTERNAL_THREAD_PREWARM_PARAM,
  THREAD_PREWARM_DISCARD_METHOD,
  threadPrewarmDiscardParamsSchema,
  REMOTE_SSH_SETUP_METHOD,
  CONSOLE_REMOTE_CONNECTIONS_METHOD,
  remoteSshSetupParamsSchema,
  RUNTIME_STATUS_METHOD,
  REMOTE_UPDATE_METHOD,
  remoteUpdateParamsSchema,
  harnessInstallationRequestTimeoutMs,
} from "@codexhost/shared-contracts";
import { requestDesktopRemoteConnections } from "@codexhost/desktop-control";
import type { RuntimeMaintenance } from "./runtime-maintenance.js";
import { ExternalThreadPrewarms } from "./external-thread-prewarms.js";
import {
  HarnessLaunchSettingsStore,
  HarnessPreferencesStore,
} from "@codexhost/harness-plugin-files";
import {
  HARNESS_PREFERENCES_CHANGED_METHOD,
  DEFAULT_IDLE_RELEASE_SETTINGS,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";
import {
  isConsoleHostMethod,
  consoleOpenParamsSchema,
  consoleOpenResultSchema,
} from "@codexhost/shared-contracts";
import {
  DELEGATION_MENTION_PATH_PREFIX,
  IDLE_RELEASE_SETTINGS_METHOD,
  restoreHarnessCommandMentions,
  LOADED_SESSIONS_METHOD,
} from "@codexhost/shared-contracts";
import { HarnessDisplaySettingsStore } from "./harness-display-settings.js";
import { isModelPriceOverridesMethod } from "./model-price-overrides-file.js";
import { HARNESS_DISPLAY_CHANGED_METHOD } from "@codexhost/shared-contracts";
import {
  rewriteDelegationMentionInput,
  rewriteDelegationMentionText,
} from "./delegation-mention-rewrite.js";
import { managedDelegationSkillReference } from "./delegation-skill.js";
import { AccountRateLimits } from "./codex-runtime/account-rate-limits.js";
import { NativeAccountObserver } from "./native-account-observer.js";
import { nativeThreadSupportsReferences } from "./native-thread-reference-capability.js";
import { THREAD_REFERENCE_SOURCE_HOST_PARAM } from "@codexhost/shared-contracts";
import { HarnessAccountInspectionCache } from "./harness-accounts.js";
import type { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostApprovalInteraction,
  HostSubagentState,
  HostApprovalResponse,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import {
  parseHarnessAccountCredits,
  type HostEvent,
  type HostUsage,
} from "@codexhost/harness-adapter";
import type {
  HarnessPluginContext,
  HarnessUsageStatisticsAdapter,
} from "@codexhost/harness-adapter/plugin";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  type HarnessAccountInspectResult,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  type HarnessPluginDescriptor,
  externalThreadForkParamsSchema,
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
  type HarnessId,
  type HarnessPluginSurface,
  harnessIdSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  externalThreadForkResultSchema,
  harnessInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectionSchema,
  harnessWebUiOpenParamsSchema,
  harnessWebUiOpenResultSchema,
  harnessModelSelectionStateSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  threadSteeringInspectParamsSchema,
  threadSteeringInspectResultSchema,
  permissionModeFixedAtCreate,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  type AccountCreditsSnapshot,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { executeExternalThreadFork } from "./external-thread-fork.js";
import { settleExternalOutputFailure } from "./external-output-failure.js";
import { SessionImportRequests } from "./session-import-requests.js";
import {
  sharedQuestion,
  usesSharedQuestionCard,
  validateSharedQuestionResponse,
} from "./shared-question.js";
import {
  ExternalHistoryRequestError,
  listExternalItems,
  listExternalTurns,
} from "./external-thread-history.js";
import { executeExternalThreadRollback } from "./external-thread-rollback.js";
import {
  createExternalThreadRecordInput,
  createProductionExternalThreadStore,
  ExternalThreadRepository,
  externalThreadValue,
  threadSectionFields,
  type ExternalThreadStore,
} from "./external-thread-repository.js";
import {
  ExternalThreadRuntime,
  type ExternalThread,
  type ExternalThreadLocation,
  type ExternalThreadResolution,
} from "./external-thread-runtime.js";
import { ExternalSessionReleaseError } from "./external-thread-lifecycle.js";
import {
  ExternalSteerError,
  ExternalTurnSteering,
  externalSteeringDelivery,
  insertNativeSteer,
} from "./external-turn-steering.js";
import {
  ExternalQueueError,
  ExternalThreadQueue,
  nativeQueuedSubmission,
} from "./external-thread-queue.js";
import {
  ExternalCommandError,
  inspectLiveCommandCatalog,
  isExternalCommandCandidate,
  resolveExternalCommand,
} from "./external-command-routing.js";
import {
  isLiveCommandCatalog,
  LiveCommandCatalogCache,
  sameWorkspace,
} from "./live-command-catalog-cache.js";
import {
  DELEGATION_CLI_PATH_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
} from "./delegation-types.js";
import { HarnessDelegationCoordinator } from "./harness-delegation-coordinator.js";
import { loadHarnessPlugins } from "./harness-plugin-loader.js";
import type { HarnessPluginRegistry } from "./harness-plugin-registry.js";
import { DesktopRequestQueue } from "./desktop-request-queue.js";
import type {
  DelegationControlRegistration,
  DelegationStartInput,
  DelegationStartResult,
  DelegationThreadListResult,
  DelegationThreadSnapshot,
  HarnessInspectInput,
  HarnessInspectResult,
  ThreadCancelInput,
  ThreadCancelResult,
  ThreadListInput,
  ThreadReadInput,
  ThreadSendInput,
  ThreadSendResult,
} from "./delegation-types.js";
import { projectDelegationThreadSnapshot } from "./delegation-snapshot.js";
import {
  canonicalizeOfficialCodexModelRef,
  decodeOfficialCodexModelRef,
  encodeOfficialCodexModelRef,
} from "./official-codex-model-ref.js";
import {
  spawnOfficialAppServerConnection,
  type OfficialAppServerConnection,
} from "./official-app-server-connection.js";
import {
  SingleNativeCodexAccount,
  type CodexAccountControl,
} from "./account/codex-account-control.js";

import {
  createOwnedConnectionBackend,
  OfficialRuntimeClient,
  OfficialRuntimeScope,
} from "./codex-runtime/official-runtime-scope.js";
import type { HostUpdateCoordinator } from "./update-coordinator.js";
import type { HostConsoleOpener } from "./console-opener.js";

const CONSOLE_REQUEST_TIMEOUT_MS = 120_000;

import { ClientChannelEvents } from "./client-channel-events.js";
import { ClientChannelHost } from "./client-channel-host.js";
import {
  ExternalTurnProjection,
  projectedTurn,
  waitForTurnResponse,
  type ExternalThreadStatus,
  type ProjectedTurn,
} from "./external-turn-projection.js";
import { DesktopControlRequests } from "./desktop-control-requests.js";
import { DesktopThreadRouting } from "./desktop-thread-routing.js";
import { errorMessage, rpcEnvelope, rpcError, type HostRequestOrigin } from "./desktop-rpc.js";
import { allocateProjectlessWorkspace } from "./projectless-workspace.js";
import {
  clientProjectlessWorkspaceSchema,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
  type ClientChannelResponse,
} from "@codexhost/shared-contracts";

export type ConsoleHostReply = { result: JsonValue } | { error: { code: number; message: string } };

const SUBAGENT_TERMINAL_REFRESH_DELAYS_MS = [0, 50, 100, 150] as const;
const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
// Native Codex account quota is still pulled through its official API; keep
// that reading briefly cached so concurrent Composer inspections coalesce.

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
import {
  classifyCreateRequestRoute,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";

export { classifyCreateRequestRoute };
import {
  aggregateThreadList,
  officialThreadListPageFromResponse,
  OfficialThreadListError,
} from "./thread-list-aggregator.js";
import { listSectionThreads, moveThreadSection } from "./external-thread-sections.js";
import { externalThreadListEntries } from "./external-thread-list.js";
import { ModelPriceCatalog } from "./model-prices.js";
import { UsageMeasurementsStore } from "./usage-measurements-store.js";
import { ObservedSessionUsage } from "./observed-session-usage.js";
import type { UsageStatistics, UsageStatisticsSource } from "./usage-statistics.js";
import { USAGE_STATISTICS_METHOD } from "@codexhost/shared-contracts";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  decodeThreadListRequest,
  encodeJsonFrame,
  mapExternalThreadHarnessError,
  projectCodexRateLimitsToCredits,
  observeCodexRateLimits,
  observeDeletedProject,
  parseJsonFrame,
  projectCodexThreadUsage,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  threadForkResult,
  threadRevertResult,
  threadRollbackResult,
  transportModelIdForHarness,
  type CodexApprovalProjection,
  type CodexQuestionProjection,
  type DecodedThreadForkRequest,
  type DecodedThreadListRequest,
  type DecodedThreadMetadataUpdateRequest,
  type DecodedThreadSectionMoveRequest,
  type DecodedThreadRevertRequest,
  type DecodedThreadRollbackRequest,
  type ExternalThreadRpcError,
  type CodexApprovalRequestProjection,
  type CodexQuestionRequestProjection,
  type ExternalHarnessId,
  type JsonObject,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonValue,
} from "@codexhost/protocol-core";

export interface AppServerHostOptions {
  /** Private external-session owner: never forwards requests to native Codex. */
  externalOnly?: boolean;
  /** GUI connection to the single external-session owner. */
  sharedThreads?: SharedThreadBridge;
  /** In-process SSH fronts send external Delegations to the same owner as GUI requests. */
  sharedDelegation?: DelegationControlRegistration;
  stockCodexPath: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  desktopInput?: Readable;
  desktopOutput?: Writable;
  diagnosticOutput?: Writable;
  externalAdapters?: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  pluginRoots?: readonly string[];
  pluginContext?: HarnessPluginContext;
  mappingStore?: ExternalThreadStore;
  /** Defaults to true. A listener that shares one store across sessions owns closing it. */
  closeMappingStoreOnExit?: boolean;
  spawnOfficial?: typeof spawn;
  /** Grace period for each official app-server stop step. Tests shorten it. */
  officialCloseTimeoutMs?: number;
  createOfficialConnection?: () =>
    OfficialAppServerConnection | Promise<OfficialAppServerConnection>;
  accountControl?: CodexAccountControl;
  /** Shared by all Desktop/Remote Control sessions belonging to one Host. */
  officialRuntimeScope?: OfficialRuntimeScope;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
  updateCoordinator?: HostUpdateCoordinator;
  runtimeMaintenance?: RuntimeMaintenance;
  /** Present only on the local Host started by the Launcher. */
  consoleOpener?: HostConsoleOpener;
  onDelegationApi?: (api: DelegationControlRegistration) => (() => void) | undefined;
  /** Shared by all Hosts of one runtime; defaults to the bundled snapshot only. */
  modelPrices?: ModelPriceCatalog;
  /** Machine-wide usage statistics; one per runtime, read from the loaded Harness plugins. */
  usageStatistics?: UsageStatistics;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

type HostApprovalRequestId = number;
type HostQuestionRequestId = number;

interface PendingDesktopApproval {
  thread: ExternalThread;
  interaction: HostApprovalInteraction;
  projection: CodexApprovalRequestProjection;
}

interface PendingDesktopQuestion {
  shared: boolean;
  responding: boolean;
  thread: ExternalThread;
  interaction: HostQuestionInteraction;
  projection: CodexQuestionRequestProjection;
  timeout: NodeJS.Timeout | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialThreadBusy(thread: Record<string, unknown> | null): boolean {
  if (thread && isRecord(thread.status) && thread.status.type === "active") return true;
  const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  const latestTurn = turns.at(-1);
  return (
    isRecord(latestTurn) && (latestTurn.status === "inProgress" || latestTurn.status === "running")
  );
}

/**
 * Codex app-server reports an unknown Thread with these messages. Any other
 * error from a Thread read is a failure to read, not proof that it is missing.
 */
const OFFICIAL_THREAD_MISSING =
  /no rollout found for thread id|thread not found|invalid thread id/i;

function officialThreadReadError(error: Record<string, unknown>): DelegationControlError {
  const message = typeof error.message === "string" ? error.message : "";
  return OFFICIAL_THREAD_MISSING.test(message)
    ? new DelegationControlError("THREAD_NOT_FOUND", message || "Official Thread was not found")
    : new DelegationControlError(
        "INTERNAL_ERROR",
        message ? `Official Thread read failed: ${message}` : "Official Thread read failed",
      );
}

function codexAccountRpcError(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : "";
  return message === "Unknown Codex Account"
    ? { code: -32086, message }
    : { code: -32086, message: "Codex Account operation failed" };
}

export function officialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    DELEGATION_CLI_PATH_ENV,
    DELEGATION_RUNTIME_ENDPOINT_ENV,
    DELEGATION_RUNTIME_TOKEN_ENV,
  ]);
  const internal = new Set([
    "CODEX_CLI_PATH",
    "CODEXHOST_HOST_NODE_PATH",
    "CODEXHOST_DATA_DIR",
    // Retired setting still exported by older remote SSH profile blocks.
    "CODEXHOST_DEFAULT_AGENT",
    "CODEXHOST_HOST_RUNTIME_PATH",
    "CODEXHOST_PI_COMMAND",
    "CODEXHOST_ENABLE_CLAUDE_CODE",
    "CODEXHOST_CLAUDE_COMMAND",
    "CODEXHOST_OPENCODE_COMMAND",
    "CODEXHOST_STOCK_CODEX_PATH",
    "CODEXHOST_LAUNCHER_PID",
    "CODEXHOST_LAUNCHER_EXECUTABLE",
    "CODEXHOST_RUNTIME_DESCRIPTOR_PATH",
    "CODEXHOST_CONTROL_PORT",
    "CODEXHOST_CONTROL_NONCE",
    "CODEXHOST_NPM_NODE_PATH",
    "CODEXHOST_NPM_CLI_PATH",
    "CODEXHOST_NPM_LAUNCHER_PATH",
    "CODEXHOST_NPM_PACKAGE_ROOT",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !internal.has(key) || allowed.has(key)),
  );
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const HOST_APPROVAL_REQUEST_ID_MIN = -2_000_000;
const HOST_APPROVAL_REQUEST_ID_MAX = -1_000_001;
const HOST_QUESTION_REQUEST_ID_MIN = -1_000_000;
const HOST_QUESTION_REQUEST_ID_MAX = -1;

function isHostApprovalRequestId(value: unknown): value is HostApprovalRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_APPROVAL_REQUEST_ID_MIN &&
    value <= HOST_APPROVAL_REQUEST_ID_MAX
  );
}

function isHostQuestionRequestId(value: unknown): value is HostQuestionRequestId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= HOST_QUESTION_REQUEST_ID_MIN &&
    value <= HOST_QUESTION_REQUEST_ID_MAX
  );
}

function requestObject(request: JsonRpcRequest): JsonObject {
  if (!isRecord(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params as JsonObject;
}

function requestInput(params: JsonObject): JsonObject[] {
  if (!Array.isArray(params.input) || params.input.some((item) => !isRecord(item)))
    throw new Error("turn/start input must be an array of input objects");
  return params.input as JsonObject[];
}

function requestPresentationInput(params: JsonObject): JsonObject[] | undefined {
  if (params.presentationInput === undefined) return undefined;
  if (
    !Array.isArray(params.presentationInput) ||
    params.presentationInput.some((item) => !isRecord(item))
  )
    throw new Error("presentationInput must be an array of input objects");
  return params.presentationInput as JsonObject[];
}

function requestText(params: JsonObject): string {
  const text = requestInput(params)
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (!text) throw new Error("turn/start must contain text input");
  return text;
}

function sandboxResult(params: JsonObject): JsonObject {
  const sandbox = params.sandbox;
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function turnProjectionGate(): TurnProjectionGate {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class OrderedWriter {
  #tail = Promise.resolve();

  constructor(
    private readonly stream: Writable,
    /** Returns true for a message it consumed instead of the stream. */
    private readonly intercept: (value: JsonValue) => boolean = () => false,
    /** Returns true to withhold a message this connection must not receive. */
    private readonly suppress: (value: JsonValue) => boolean = () => false,
  ) {}

  frame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }

  json(value: JsonValue): Promise<void> {
    if (this.intercept(value) || this.suppress(value)) return Promise.resolve();
    return this.#enqueue(() => writeJsonFrame(this.stream, value));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class AppServerHost {
  readonly #options: Required<
    Pick<AppServerHostOptions, "desktopInput" | "desktopOutput" | "diagnosticOutput">
  > &
    AppServerHostOptions;
  #officialRuntime: OfficialRuntimeClient;
  #officialRuntimeScope: OfficialRuntimeScope;
  #ownsOfficialRuntimeScope: boolean;
  #accountControl: CodexAccountControl;
  #nativeAccountObserver: NativeAccountObserver | undefined;
  #externalAdapters: Map<ExternalHarnessId, HarnessAdapter>;
  #pluginDescriptors: HarnessPluginDescriptor[] = [];
  #pluginSurfaces: ReadonlyMap<HarnessId, ReadonlySet<HarnessPluginSurface>> = new Map();
  #usageOnlyAdapters: HarnessUsageStatisticsAdapter[] = [];
  #plugins: HarnessPluginRegistry | undefined;
  readonly #launchSettings: HarnessLaunchSettingsStore;
  readonly #displaySettings: HarnessDisplaySettingsStore;
  readonly #preferences: HarnessPreferencesStore;
  #appliedPreferenceRevision = -1;
  readonly #accountInspections = new HarnessAccountInspectionCache();
  #externalRuntime!: ExternalThreadRuntime;
  readonly #executionHosts = new WeakMap<ExternalThread, string>();
  readonly #externalPrewarms = new ExternalThreadPrewarms();
  readonly #externalSteering = new ExternalTurnSteering();
  readonly #liveCommandCache = new LiveCommandCatalogCache();
  readonly #modelPrices: ModelPriceCatalog;
  readonly #observedSessionUsage: ObservedSessionUsage;
  #repository: ExternalThreadRepository;
  #pendingDesktopApprovals = new Map<HostApprovalRequestId, PendingDesktopApproval>();
  #pendingDesktopQuestions = new Map<HostQuestionRequestId, PendingDesktopQuestion>();
  #nextApprovalRequestId = HOST_APPROVAL_REQUEST_ID_MAX;
  #nextQuestionRequestId = HOST_QUESTION_REQUEST_ID_MAX;
  #delegationCoordinator: HarnessDelegationCoordinator;
  #sessionImportRequests: SessionImportRequests | undefined;
  #unregisterDelegationApi: (() => void) | undefined;
  #unsubscribeAccountState: (() => void) | undefined;
  #activeOfficialTurns = new Map<string, string>();
  /** Active reply guards by request ID; each records whether its request was answered. */
  readonly #replyGuards = new Map<unknown, Set<{ answered: boolean }>>();
  #pendingOfficialTurnStarts = new Map<unknown, string>();
  #activeWorkDrainWaiters = new Set<() => void>();
  #pendingOfficialDelegationThreads = new Set<string>();
  #pendingOfficialTerminalStatuses = new Map<string, DelegationStartResult["status"]>();
  readonly #officialRateLimits = new AccountRateLimits();
  #routeObservationTracker = new RequestRouteObservationTracker();
  #officialServerRequests = new Map<JsonRpcId, JsonRpcId>();
  #nextOfficialServerRequestId = 0;
  #writer: OrderedWriter;
  readonly clientEvents = new ClientChannelEvents();
  readonly #client: ClientChannelHost;
  readonly #desktopControl: DesktopControlRequests;
  readonly #threadRouting: DesktopThreadRouting;
  readonly #turnProjection: ExternalTurnProjection;
  /** Console requests share Desktop handling; their replies return to the console. */
  readonly #consoleRequestPrefix = `codexhost-console:${randomUUID()}:`;
  readonly #clientRequestPrefix = `${this.#consoleRequestPrefix}client:`;
  readonly #consoleReplies = new Map<string, (message: JsonValue) => void>();
  #nextConsoleRequest = 0;
  #subagentThreadStatuses = new Map<string, "active" | "idle">();
  #runningSubagentsByParent = new Map<string, Set<string>>();
  #pendingExternalCommandRequests = new Set<string>();
  readonly #externalQueue = new ExternalThreadQueue();
  readonly #queuedTurnStarts = new Map<
    string,
    {
      itemId: string;
      result: Promise<{ turnId: HostTurnId; turn: JsonObject; gate: TurnProjectionGate }>;
    }
  >();
  #manualCompactionTurns = new WeakMap<ExternalThread, HostTurnId>();
  #closeRequested = false;
  readonly #pluginLoadAbort = new AbortController();
  #pluginLoading: Promise<void> | undefined;
  #usagePluginsReady: Promise<void> | undefined;
  /** Settles once manifests declared their surfaces, before plugin imports and warmup. */
  #pluginSurfacesReady: Promise<void> | undefined;
  readonly #desktopRequests = new DesktopRequestQueue();
  #drainActiveWorkOnInputEnd = false;
  #desktopInputEnded = false;

  constructor(options: AppServerHostOptions) {
    this.#options = {
      desktopInput: process.stdin,
      desktopOutput: process.stdout,
      diagnosticOutput: process.stderr,
      ...options,
    };
    this.#modelPrices = options.modelPrices ?? new ModelPriceCatalog();
    this.#observedSessionUsage = new ObservedSessionUsage(
      () =>
        [...this.#externalAdapters.values(), ...this.#usageOnlyAdapters].flatMap((adapter) =>
          adapter.sessionUsage ? [adapter.sessionUsage] : [],
        ),
      this.#modelPrices,
      (error) => this.#diagnose(error),
      new UsageMeasurementsStore(
        path.resolve(
          (options.environment ?? process.env).CODEXHOST_DATA_DIR ??
            path.join((options.environment ?? process.env).HOME ?? os.homedir(), ".codexhost"),
        ),
        (error) => this.#diagnose(error),
      ),
    );
    this.#client = new ClientChannelHost({
      events: this.clientEvents,
      interactions: {
        approvals: this.#pendingDesktopApprovals,
        questions: this.#pendingDesktopQuestions,
        isApprovalRequestId: isHostApprovalRequestId,
        isQuestionRequestId: isHostQuestionRequestId,
        respondApproval: (response) => this.#handleDesktopApprovalResponse(response),
        respondQuestion: (response) => this.#handleDesktopQuestionResponse(response, true),
      },
      environment: () => this.#options.environment ?? process.env,
      waitForPlugins: () => this.#waitForPlugins(),
      listRecords: () => this.#repository.list(),
      locateExternalThread: (threadId) => this.#locateExternalThread(threadId),
      loadedThread: (threadId) => this.#externalRuntime?.get(threadId),
      clientHistoryTurns: (thread) => this.#externalHistoryTurns(thread, true),
      queueSnapshot: (threadId) => this.#externalQueue.snapshot(threadId),
      submit: (method, params, timeoutMs) =>
        this.#handleControlRequest(
          method,
          params,
          timeoutMs ?? CONSOLE_REQUEST_TIMEOUT_MS,
          "client",
        ),
    });
    this.#writer = new OrderedWriter(
      this.#options.desktopOutput,
      (value) => {
        this.#noteDesktopReply(value);
        this.#client.observeDesktopMessage(value);
        return this.#takeConsoleReply(value);
      },
      (value) => this.#dropsDesktopEvent(value),
    );
    const environment = this.#options.environment ?? process.env;
    this.#displaySettings = new HarnessDisplaySettingsStore(options.environment ?? process.env);
    this.#preferences = new HarnessPreferencesStore(
      path.resolve(
        environment.CODEXHOST_DATA_DIR ?? path.join(environment.HOME ?? os.homedir(), ".codexhost"),
      ),
    );
    this.#launchSettings = new HarnessLaunchSettingsStore(
      this.#options.pluginContext?.environment ?? environment,
    );
    const permanentHome = path.resolve(environment.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
    this.#ownsOfficialRuntimeScope = options.officialRuntimeScope === undefined;
    this.#officialRuntimeScope =
      options.officialRuntimeScope ??
      new OfficialRuntimeScope({
        diagnosticOutput: this.#options.diagnosticOutput,
        permanentHome,
        createBackend: () =>
          createOwnedConnectionBackend(() =>
            options.createOfficialConnection
              ? options.createOfficialConnection()
              : spawnOfficialAppServerConnection({
                  stockCodexPath: this.#options.stockCodexPath,
                  arguments: this.#options.arguments,
                  environment: {
                    ...officialEnvironment(environment),
                    CODEX_HOME: permanentHome,
                  },
                  ...(this.#options.spawnOfficial
                    ? { spawnOfficial: this.#options.spawnOfficial }
                    : {}),
                  ...(this.#options.officialCloseTimeoutMs === undefined
                    ? {}
                    : { closeTimeoutMs: this.#options.officialCloseTimeoutMs }),
                }),
          ),
      });
    this.#accountControl =
      options.accountControl ??
      new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: "00000000-0000-4000-8000-000000000001",
        phase: this.#officialRuntimeScope.gate.phase,
        revision: this.#officialRuntimeScope.gate.revision,
        accounts: [
          {
            accountId: "00000000-0000-4000-8000-000000000001",
            label: "Native Codex Account",
          },
        ],
      }));
    this.#officialRuntime = new OfficialRuntimeClient({
      scope: this.#officialRuntimeScope,
      onBackendStopped: () => {
        this.#pendingOfficialTurnStarts.clear();
        this.#activeOfficialTurns.clear();
        this.#signalActiveWorkChanged();
      },
      output: async (output) =>
        this.#handleOfficialOutput({
          ...output,
          accountId: (await this.#currentCodexAccountId()) ?? "signed-out",
        }),
    });
    this.#nativeAccountObserver = this.#accountControl.refresh
      ? new NativeAccountObserver({
          control: this.#accountControl,
          scope: this.#officialRuntimeScope,
          notify: (method, params) => this.#writer.json({ method, params }),
          diagnose: () =>
            this.#diagnose("Codex Account identity or notification could not be updated"),
        })
      : undefined;
    this.#unsubscribeAccountState = this.#officialRuntimeScope.gate.subscribe(() => {
      if (this.#options.externalOnly) return;
      const snapshot = this.#accountControl.snapshot();
      void this.#writer
        .json({ method: "codexhost/account/changed", params: jsonValueSchema.parse(snapshot) })
        .catch(() => undefined);
    });
    this.#repository = new ExternalThreadRepository(
      options.mappingStore ??
        createProductionExternalThreadStore(this.#options.environment ?? process.env),
    );
    this.#externalAdapters = new Map(options.externalAdapters);
    for (const [harnessId, adapter] of this.#externalAdapters) {
      if (adapter.harnessId !== harnessId) {
        throw new Error(`External Adapter '${harnessId}' has mismatched Harness ID`);
      }
    }
    this.#externalRuntime = new ExternalThreadRuntime({
      adapters: this.#externalAdapters,
      environment: this.#options.environment ?? process.env,
      repository: this.#repository,
      consumeOutputs: (thread) => this.#consumeHarnessOutputs(thread),
      diagnose: (error) => this.#diagnose(error),
      subagentRunning: (threadId) => this.#subagentThreadStatuses.get(threadId) === "active",
      hasRunningDescendants: (threadId) => this.#hasRunningSubagents(threadId),
      idleRelease: {
        queue: this.#desktopRequests,
        onClosed: (thread) => this.#resolveThreadInteractions(thread),
        canRelease: (thread) =>
          !this.#hasRunningSubagents(thread.id) &&
          !thread.session.hasBackgroundWork?.() &&
          !this.#externalSteering.hasPending(thread.id) &&
          !this.#pendingExternalCommandRequests.has(thread.id) &&
          ![...this.#pendingDesktopApprovals.values()].some(
            (pending) => pending.thread === thread,
          ) &&
          ![...this.#pendingDesktopQuestions.values()].some((pending) => pending.thread === thread),
      },
    });
    this.#delegationCoordinator = new HarnessDelegationCoordinator({
      adapters: this.#externalAdapters,
      environment: this.#options.environment ?? process.env,
      externalRuntime: this.#externalRuntime,
      repository: this.#repository,
      registerExternalThread: (input) => this.#registerExternalThread(input),
      startExternalTurn: (thread, text, turnId) =>
        this.#startDelegatedExternalTurn(thread, text, turnId),
      notifyThreadStarted: (thread) => this.#notifyExternalThreadStarted(thread),
      inspectOfficial: (input) => this.#inspectOfficialDelegationTarget(input),
      readOfficial: (input) => this.#readOfficialDelegationThread(input),
      sendOfficial: (input) => this.#sendOfficialDelegationThread(input),
      cancelOfficial: (input) => this.#cancelOfficialDelegationThread(input),
      startOfficial: (input) => this.#startOfficialDelegation(input),
      listOfficial: (input) => this.#listDelegationThreads(input),
      officialThreadMetadata: (threadId) => this.#readOfficialThreadMetadata(threadId),
      activeOfficialParents: () => [...this.#activeOfficialTurns.keys()],
      externalThreadBusy: (thread) => this.#externalThreadBusy(thread),
      harnessSurfaces: (harnessId) => this.#pluginSurfaces.get(harnessId as HarnessId),
    });
    const maintenanceOperation = <T>(run: () => Promise<T>): Promise<T> =>
      options.runtimeMaintenance ? options.runtimeMaintenance.operation(run) : run();
    const unregisterDelegationApi = options.onDelegationApi?.({
      listHarnesses: (input) =>
        this.#waitForPlugins().then(() => this.#delegationCoordinator.listHarnesses(input)),
      inspect: (input) =>
        this.#waitForPlugins().then(() => this.#delegationCoordinator.inspect(input)),
      start: (input) =>
        maintenanceOperation(async () => {
          if (options.sharedDelegation && input.harnessId !== "codex") {
            const active = [...this.#activeOfficialTurns.keys()];
            const parentThreadId =
              input.parentThreadId ?? (active.length === 1 ? active[0] : undefined);
            return options.sharedDelegation.start({
              ...input,
              ...(parentThreadId ? { parentThreadId } : {}),
            });
          }
          return this.#waitForPlugins().then(() => this.#delegationCoordinator.start(input));
        }),
      send: (input) =>
        maintenanceOperation(() =>
          this.#waitForPlugins().then(() => this.#delegationCoordinator.send(input)),
        ),
      cancel: (input) =>
        this.#waitForPlugins().then(() => this.#delegationCoordinator.cancel(input)),
      read: (input) => this.#waitForPlugins().then(() => this.#delegationCoordinator.read(input)),
      wait: (input) => this.#waitForPlugins().then(() => this.#delegationCoordinator.wait(input)),
      list: (input) => this.#waitForPlugins().then(() => this.#delegationCoordinator.list(input)),
      canHandleStart: (input) => this.#canHandleDelegationStart(input),
      ownsThread: (threadId) => this.#ownsDelegationThread(threadId),
      executionHostId: (threadId) => {
        const thread = this.#externalRuntime.get(threadId);
        return thread ? this.#executionHosts.get(thread) : undefined;
      },
    });
    this.#unregisterDelegationApi =
      typeof unregisterDelegationApi === "function" ? unregisterDelegationApi : undefined;
    this.#turnProjection = new ExternalTurnProjection({
      writeJson: (value) => this.#writer.json(value),
      repository: this.#repository,
      steering: this.#externalSteering,
      queue: this.#externalQueue,
      manualCompactionTurns: this.#manualCompactionTurns,
      outputFailed: (thread) => this.#externalRuntime.idleRelease.outputFailed(thread),
      submitPrewarm: (thread) => this.#externalRuntime.submitPrewarm(thread),
      notifyExternalThreadStarted: (thread) => this.#notifyExternalThreadStarted(thread),
      persistTerminalIdentity: (thread, event) =>
        this.#externalRuntime.persistTerminalIdentity(thread, event),
      resolveDesktopApproval: (interactionId, thread) =>
        this.#resolveDesktopApproval(interactionId, thread),
      resolveDesktopQuestion: (interactionId, thread) =>
        this.#resolveDesktopQuestion(interactionId, thread),
      retireSharedQuestions: (thread, turnId) => this.#retireSharedQuestions(thread, turnId),
      setThreadStatus: (thread, status) => this.#setThreadStatus(thread, status),
      forgetQueuedTurnStart: (threadId) => this.#queuedTurnStarts.delete(threadId),
      signalActiveWorkChanged: () => this.#signalActiveWorkChanged(),
      hasRunningSubagents: (parentThreadId) => this.#hasRunningSubagents(parentThreadId),
      publishExternalQueue: (threadId) => this.#publishExternalQueue(threadId),
      startNextQueuedExternalTurn: (thread) => this.#startNextQueuedExternalTurn(thread),
    });
    this.#desktopControl = new DesktopControlRequests({
      writeJson: (value) => this.#writer.json(value),
      dispatchReply: (request, run, threadId) => this.#dispatchDesktopReply(request, run, threadId),
      waitForPlugins: () => this.#waitForPlugins(),
      diagnose: (error) => this.#diagnose(error),
      environment: this.#options.environment ?? process.env,
      preferences: this.#preferences,
      displaySettings: this.#displaySettings,
      launchSettings: this.#launchSettings,
      modelPrices: this.#modelPrices,
      usageStatistics: this.#options.usageStatistics,
      externalAdapters: this.#externalAdapters,
      pluginDescriptors: () => this.#pluginDescriptors,
      listLoadedSessions: () => this.#externalRuntime.idleRelease.list(),
      applyHarnessPreferences: (snapshot) => this.#applyHarnessPreferences(snapshot),
      attachUsageStatistics: () => this.#attachUsageStatistics(),
      eligibleFor: (origin, surface, harnessId) => this.#eligibleFor(origin, surface, harnessId),
      inspectHarnessAccount: (adapter, refresh) => this.#inspectHarnessAccount(adapter, refresh),
      handleUpdateRequest: (request) => this.#handleUpdateRequest(request),
      handleConsoleOpen: (request) => this.#handleConsoleOpen(request),
      handleCodexAccountRequest: (request) => this.#handleCodexAccountRequest(request),
      inspectHarness: (request) => this.#inspectHarness(request),
      openHarnessWebUi: (request) => this.#openHarnessWebUi(request),
      handleSessionImport: (request) => this.#handleSessionImport(request),
    });
    this.#threadRouting = new DesktopThreadRouting({
      writeJson: (value) => this.#writer.json(value),
      dispatchReply: (request, run, threadId) => this.#dispatchDesktopReply(request, run, threadId),
      routeCallbacks: this.#options,
      routeObservationTracker: this.#routeObservationTracker,
      pendingOfficialTurnStarts: this.#pendingOfficialTurnStarts,
      locateExternalThread: (threadId) => this.#locateExternalThread(threadId),
      resolveExternalThread: (threadId) => this.#resolveExternalThread(threadId),
      writeResolutionError: (request, resolution) =>
        this.#writeResolutionError(request, resolution),
      forwardOfficialRequest: (request, frame) => this.#forwardOfficialRequest(request, frame),
      startExternalThread: (request, harnessId, origin) =>
        this.#startExternalThread(request, harnessId, origin),
      forkExternalThreadFromRenderer: (request) => this.#forkExternalThreadFromRenderer(request),
      inspectThread: (request) => this.#inspectThread(request),
      inspectThreadUsage: (request) => this.#inspectThreadUsage(request),
      listThreadOwnership: (request) => this.#listThreadOwnership(request),
      inspectThreadSteering: (request) => this.#inspectThreadSteering(request),
      handleSharedQuestionRequest: (request) => this.#handleSharedQuestionRequest(request),
      selectThreadModel: (request) => this.#selectThreadModel(request),
      selectThreadThinking: (request) => this.#selectThreadThinking(request),
      selectThreadPermissionMode: (request) => this.#selectThreadPermissionMode(request),
      writeHarnessCommandCatalog: (request, harnessId, cwd, inspectedThreadId) =>
        this.#writeHarnessCommandCatalog(request, harnessId, cwd, inspectedThreadId),
      inspectThreadCommands: (request) => this.#inspectThreadCommands(request),
      executeThreadCommand: (request) => this.#executeThreadCommand(request),
      sendQueuedExternalTurnNow: (request, thread) =>
        this.#sendQueuedExternalTurnNow(request, thread),
      handleExternalQueueRequest: (request, thread) =>
        this.#handleExternalQueueRequest(request, thread),
      listSectionThreads: (request, frame, query, origin) =>
        this.#listSectionThreads(request, frame, query, origin),
      listThreads: (request, listRequest, origin) =>
        this.#listThreads(request, listRequest, origin),
      moveThreadSection: (request, frame, move) => this.#moveThreadSection(request, frame, move),
      setExternalThreadArchived: (request, location, archived) =>
        this.#setExternalThreadArchived(request, location, archived),
      updateExternalThreadMetadata: (request, location, update) =>
        this.#updateExternalThreadMetadata(request, location, update),
      forkExternalThread: (request, source, fork) =>
        this.#forkExternalThread(request, source, fork),
      revertExternalThread: (request, thread, revert) =>
        this.#revertExternalThread(request, thread, revert),
      rollbackExternalThread: (request, derived, rollback) =>
        this.#rollbackExternalThread(request, derived, rollback),
      listExternalHistory: (request, thread, params, historyFresh) =>
        this.#listExternalHistory(request, thread, params, historyFresh),
      startExternalTurn: (request, thread) => this.#startExternalTurn(request, thread),
      steerExternalTurn: (request, thread) => this.#steerExternalTurn(request, thread),
      interruptExternalTurn: (request, thread, requestedTurnId) =>
        this.#interruptExternalTurn(request, thread, requestedTurnId),
      readExternalThreadMetadata: (request, location) =>
        this.#readExternalThreadMetadata(request, location),
      readExternalThread: (request, thread, includeTurns, historyFresh) =>
        this.#readExternalThread(request, thread, includeTurns, historyFresh),
      resumeExternalThread: (request, thread, params, historyFresh) =>
        this.#resumeExternalThread(request, thread, params, historyFresh),
      setExternalThreadName: (request, location, name) =>
        this.#setExternalThreadName(request, location, name),
      deleteExternalThread: (request, location) => this.#deleteExternalThread(request, location),
      cleanExternalBackgroundTerminals: (request, threadId) =>
        this.#cleanExternalBackgroundTerminals(request, threadId),
    });
  }

  close(): void {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    this.#options.sharedThreads?.close();
    this.#externalRuntime.idleRelease.disable();
    this.#pluginLoadAbort.abort();
    this.#externalSteering.close();
    this.#signalActiveWorkChanged();
    this.#options.desktopInput.destroy();
    // run() still awaits shutdown and propagates unconfirmed exit. This eager
    // close attempt must not create an independent unhandled rejection.
    void this.#closeOfficialRuntime().catch((error: unknown) => this.#diagnose(error));
  }

  async #closeOfficialRuntime(): Promise<void> {
    this.#nativeAccountObserver?.close();
    if (this.#ownsOfficialRuntimeScope) await this.#officialRuntimeScope.close();
    await this.#officialRuntime.close();
  }

  disconnect(): void {
    if (this.#closeRequested || this.#desktopInputEnded || this.#drainActiveWorkOnInputEnd) return;
    this.#drainActiveWorkOnInputEnd = true;
    this.#externalSteering.close();
    const desktopInput = this.#options.desktopInput as Readable & { end?: () => void };
    if (typeof desktopInput.end === "function") desktopInput.end();
    else desktopInput.destroy();
  }

  #attachUsageStatistics(): void {
    this.#options.usageStatistics?.attach(
      (): UsageStatisticsSource[] =>
        [...new Set([...this.#externalAdapters.values(), ...this.#usageOnlyAdapters])].flatMap(
          (adapter) =>
            adapter.usageStatistics
              ? [{ harness: adapter.harnessId, capability: adapter.usageStatistics }]
              : [],
        ),
      () => this.#repository.list(),
    );
  }

  #waitForPlugins(): Promise<void> {
    if (!this.#pluginLoading) {
      const ready = Promise.withResolvers<undefined>();
      const usageReady = () => ready.resolve(undefined);
      this.#usagePluginsReady = ready.promise;
      const surfaces = Promise.withResolvers<undefined>();
      const surfacesReady = () => surfaces.resolve(undefined);
      this.#pluginSurfacesReady = surfaces.promise;
      this.#pluginLoading = this.#loadInstalledPlugins(usageReady, surfacesReady)
        .catch((error: unknown) => {
          this.#diagnose(`Harness plugin load failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          usageReady();
          surfacesReady();
        });
    }
    return this.#pluginLoading;
  }

  /** Presentation filtering needs manifests only, never a slow plugin import or warmup. */
  #waitForPluginSurfaces(): Promise<void> {
    void this.#waitForPlugins();
    return this.#pluginSurfacesReady ?? Promise.resolve();
  }

  async #loadInstalledPlugins(usageReady: () => void, surfacesReady: () => void): Promise<void> {
    if (!this.#options.pluginRoots || this.#pluginLoadAbort.signal.aborted) return;
    const plugins = await loadHarnessPlugins({
      roots: this.#options.pluginRoots,
      scope: "external",
      sessionPlugins: this.#options.sharedThreads?.options.delegateCreates !== true,
      onSurfacesDeclared: (surfaces) => {
        if (!this.#pluginLoadAbort.signal.aborted) this.#pluginSurfaces = surfaces;
        surfacesReady();
      },
      onUsageAdaptersLoaded: (adapters) => {
        if (!this.#pluginLoadAbort.signal.aborted) this.#usageOnlyAdapters = [...adapters.values()];
        usageReady();
      },
      launchCommandForPlugin: (id) => this.#launchSettings.initialCommand(id),
      context: this.#options.pluginContext ?? {
        environment: this.#options.environment ?? process.env,
        platform: process.platform,
        managedRemoteHost: false,
      },
      reservedIds: new Set(this.#externalAdapters.keys()),
      signal: this.#pluginLoadAbort.signal,
      diagnose: (diagnostic) => this.#diagnose(`Harness plugin: ${JSON.stringify(diagnostic)}`),
    });
    if (this.#pluginLoadAbort.signal.aborted) {
      await plugins.close().catch((error: unknown) => this.#diagnose(error));
      return;
    }
    this.#plugins = plugins;
    this.#pluginDescriptors = plugins.list();
    this.#pluginSurfaces = plugins.surfaces();
    this.#usageOnlyAdapters = [...plugins.usageAdapters.values()];
    for (const [id, adapter] of plugins.adapters) this.#externalAdapters.set(id, adapter);
  }

  /** Omitted surfaces mean every surface; the plugin identity never decides this. */
  #visibleOn(surface: HarnessPluginSurface, harnessId: string): boolean {
    return this.#pluginSurfaces.get(harnessId as HarnessId)?.has(surface) ?? true;
  }

  /** Client-channel requests are not a Desktop surface and stay unfiltered. */
  #eligibleFor(
    origin: HostRequestOrigin,
    surface: HarnessPluginSurface,
    harnessId: string,
  ): boolean {
    return origin === "client" || this.#visibleOn(surface, harnessId);
  }

  #recordsFor(
    origin: HostRequestOrigin,
    records: readonly StoredThreadRecordV1[],
  ): readonly StoredThreadRecordV1[] {
    return origin === "client"
      ? records
      : records.filter((record) => this.#visibleOn("desktop", record.harnessId));
  }

  /**
   * A Desktop request naming one Thread of a Harness Desktop does not present is answered as a
   * missing Thread, so restored tabs or links cannot bring it back into the GUI.
   */
  #desktopThreadHarness(request: JsonRpcRequest, origin: HostRequestOrigin): string | undefined {
    if (origin !== "desktop" || !isRecord(request.params)) return undefined;
    const threadId = request.params.threadId;
    // Official Threads have no External record and pass synchronously, without any wait.
    return typeof threadId === "string" ? this.#repository.harnessOf(threadId) : undefined;
  }

  /** External Thread events stay Host-owned for a Harness this Desktop must not present. */
  #dropsDesktopEvent(value: JsonValue): boolean {
    if (!isRecord(value) || typeof value.method !== "string") return false;
    const params = isRecord(value.params) ? value.params : undefined;
    if (params === undefined) return false;
    const thread = isRecord(params.thread) ? params.thread : undefined;
    const threadId =
      typeof params.threadId === "string"
        ? params.threadId
        : typeof thread?.id === "string"
          ? thread.id
          : undefined;
    if (threadId === undefined) return false;
    const harnessId = this.#externalRuntime.get(threadId)?.harnessId;
    return harnessId !== undefined && !this.#visibleOn("desktop", harnessId);
  }

  async #closeAdapters(): Promise<void> {
    this.#displaySettings.close();
    await this.#preferences.close();
    await this.#observedSessionUsage.close();
    const results = await Promise.allSettled([
      this.#plugins?.close(),
      ...[...new Set(this.#options.externalAdapters?.values())].map((adapter) =>
        Promise.resolve().then(() => adapter.close()),
      ),
    ]);
    for (const result of results) {
      if (result.status === "rejected") this.#diagnose("Harness plugin cleanup failed");
    }
  }

  #applyHarnessPreferences(snapshot: HarnessPreferenceSnapshot): void {
    if (snapshot.scope !== "external" || snapshot.revision < this.#appliedPreferenceRevision)
      return;
    this.#externalRuntime.idleRelease.configure(
      snapshot.values.idleRelease ?? DEFAULT_IDLE_RELEASE_SETTINGS,
    );
    this.#appliedPreferenceRevision = snapshot.revision;
  }

  async run(): Promise<number> {
    try {
      await this.#repository.initialize();
      await this.#displaySettings
        .subscribe(() => {
          this.clientEvents.displaySettingsChanged();
          void this.#writer
            .json({ method: HARNESS_DISPLAY_CHANGED_METHOD, params: {} })
            .catch((error) => this.#diagnose(error));
        })
        .catch((error) => {
          this.#displaySettings.close();
          this.#diagnose(error);
        });
      if (this.#options.sharedThreads?.options.delegateCreates !== true) {
        const apply = async () => {
          const snapshot = await this.#preferences.get();
          this.#applyHarnessPreferences(snapshot);
        };
        await apply().catch((error) => this.#diagnose(error));
        await this.#preferences
          .subscribe((revision) => {
            void apply().catch((error) => this.#diagnose(error));
            this.clientEvents.preferencesChanged(revision);
            void this.#writer
              .json({ method: HARNESS_PREFERENCES_CHANGED_METHOD, params: { revision } })
              .catch((error) => this.#diagnose(error));
          })
          .catch((error) => this.#diagnose(error));
      }
    } catch (error) {
      this.#diagnose(`Host initialization failed: ${errorMessage(error)}`);
      this.#pluginLoadAbort.abort();
      await this.#pluginLoading;
      await this.#closeAdapters();
      this.#unregisterDelegationApi?.();
      this.#unregisterDelegationApi = undefined;
      this.#unsubscribeAccountState?.();
      this.#unsubscribeAccountState = undefined;
      if (this.#options.closeMappingStoreOnExit !== false) {
        await this.#repository.close().catch((closeError) => this.#diagnose(closeError));
      }
      await this.#closeOfficialRuntime();
      return this.#closeRequested ? 0 : 1;
    }
    try {
      if (!this.#options.externalOnly) await this.#officialRuntime.initialize();
    } catch (error) {
      this.#diagnose(`Official app-server connection failed: ${errorMessage(error)}`);
      // Keep the Desktop client attached for Host initialization and later recovery.
      if (this.#ownsOfficialRuntimeScope) {
        await this.#officialRuntimeScope.owner
          .stop()
          .catch((closeError: unknown) => this.#diagnose(closeError));
      }
    }
    // Load statistics plugins before native subscription negotiation; Session plugins continue
    // independently and must not hold up the official initialization.
    void this.#waitForPlugins().then(() => this.#attachUsageStatistics());
    this.#options.sharedThreads?.start((message) => {
      void this.#writer.json(message).catch((error: unknown) => this.#diagnose(error));
    });
    if (this.#closeRequested) await this.#closeOfficialRuntime();
    try {
      // The Scope proves official exit (and optionally restarts it); this native
      // client stays attached so a replacement generation can reuse it.
      await this.#forwardDesktop();
      return 0;
    } catch (error) {
      if (!this.#closeRequested) this.#diagnose(error);
      this.#options.desktopInput.destroy();
      await this.#closeOfficialRuntime();
      return this.#closeRequested ? 0 : 1;
    } finally {
      this.#options.sharedThreads?.close();
      this.#pluginLoadAbort.abort();
      // Stop replacement waiters before waiting for their tracked Host operations.
      this.#externalSteering.close();
      await this.#desktopRequests.drain();
      this.#externalRuntime.idleRelease.stop();
      await this.#externalRuntime.idleRelease.drain();
      await this.#pluginLoading;
      const threads = this.#externalRuntime.values();
      await Promise.allSettled(threads.map(({ session }) => session.close()));
      await Promise.allSettled(threads.map(({ outputTask }) => outputTask));
      await Promise.allSettled(
        threads.map((thread) => this.#externalRuntime.persistUsageMeasurements(thread)),
      );
      await this.#closeAdapters();
      await this.#externalRuntime.drain();
      for (const pending of [...this.#pendingDesktopApprovals.values()]) {
        await this.#resolveDesktopApproval(pending.interaction.interactionId, pending.thread).catch(
          () => undefined,
        );
      }
      for (const pending of [...this.#pendingDesktopQuestions.values()]) {
        await this.#resolveDesktopQuestion(pending.interaction.interactionId, pending.thread).catch(
          () => undefined,
        );
      }
      await this.#closeOfficialRuntime();
      this.#externalRuntime.clear();
      this.#externalPrewarms.clear();
      this.#pendingOfficialTurnStarts.clear();
      this.#routeObservationTracker.clear();
      this.#unregisterDelegationApi?.();
      this.#unregisterDelegationApi = undefined;
      this.#unsubscribeAccountState?.();
      this.#unsubscribeAccountState = undefined;
      if (this.#options.closeMappingStoreOnExit !== false) {
        await this.#repository.close().catch((error) => this.#diagnose(error));
      }
    }
  }

  #hasActiveWork(): boolean {
    return (
      this.#externalSteering.hasPending() ||
      this.#pendingOfficialTurnStarts.size > 0 ||
      this.#activeOfficialTurns.size > 0 ||
      this.#runningSubagentsByParent.size > 0 ||
      this.#externalRuntime
        .values()
        .some((thread) => thread.running || thread.activeTurnId !== null)
    );
  }

  async #waitForActiveWorkToDrain(): Promise<void> {
    while (!this.#closeRequested && this.#hasActiveWork()) {
      await new Promise<void>((resolve) => this.#activeWorkDrainWaiters.add(resolve));
    }
  }

  #signalActiveWorkChanged(): void {
    if (!this.#closeRequested && this.#hasActiveWork()) return;
    const waiters = [...this.#activeWorkDrainWaiters];
    this.#activeWorkDrainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #observeOfficialTurnStartResponse(value: JsonValue): void {
    if (!isRecord(value) || !("id" in value)) return;
    const threadId = this.#pendingOfficialTurnStarts.get(value.id);
    if (!threadId) return;
    this.#pendingOfficialTurnStarts.delete(value.id);
    const result = isRecord(value.result) ? value.result : null;
    const turn = result && isRecord(result.turn) ? result.turn : null;
    if (turn && typeof turn.id === "string") {
      this.#activeOfficialTurns.set(threadId, turn.id);
    }
    this.#signalActiveWorkChanged();
  }

  #takeConsoleReply(value: JsonValue): boolean {
    if (!isRecord(value) || typeof value.id !== "string") return false;
    const reply = this.#consoleReplies.get(value.id);
    if (!reply) return value.id.startsWith(this.#consoleRequestPrefix);
    this.#consoleReplies.delete(value.id);
    reply(value);
    return true;
  }

  /**
   * Runs one console request through the same handling as Codex Desktop's
   * settings requests. Only {@link CONSOLE_HOST_METHODS} are accepted.
   */
  async handleConsoleRequest(
    method: string,
    params: unknown,
    timeoutMs = CONSOLE_REQUEST_TIMEOUT_MS,
  ): Promise<ConsoleHostReply> {
    if (!isConsoleHostMethod(method)) {
      return { error: { code: -32601, message: `${method} is not available to the console` } };
    }
    if (this.#closeRequested || this.#desktopInputEnded) {
      return { error: { code: -32090, message: "Codex Desktop is closing" } };
    }
    if (method === CONSOLE_REMOTE_CONNECTIONS_METHOD) {
      return requestDesktopRemoteConnections(this.#options.environment ?? process.env, params);
    }
    if (method === REMOTE_SSH_SETUP_METHOD) timeoutMs = Math.max(timeoutMs, 330_000);
    const installationTimeout = harnessInstallationRequestTimeoutMs(method, params);
    if (installationTimeout !== undefined) timeoutMs = Math.max(timeoutMs, installationTimeout);
    return this.#handleControlRequest(method, params, timeoutMs);
  }

  async #handleControlRequest(
    method: string,
    params: unknown,
    timeoutMs = CONSOLE_REQUEST_TIMEOUT_MS,
    origin: "console" | "client" = "console",
  ): Promise<ConsoleHostReply> {
    if (this.#closeRequested || this.#desktopInputEnded)
      return { error: { code: -32090, message: "Codex Desktop is closing" } };
    const parsed = jsonRpcRequestSchema.safeParse({
      id: `${origin === "client" ? this.#clientRequestPrefix : this.#consoleRequestPrefix}${++this.#nextConsoleRequest}`,
      method,
      params: params ?? {},
    });
    if (!parsed.success) return { error: { code: -32602, message: "Invalid console request" } };
    const request = parsed.data;
    const id = String(request.id);
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<JsonValue>((resolve) => {
      this.#consoleReplies.set(id, resolve);
      timer = setTimeout(
        () => resolve({ id, error: { code: -32093, message: "The Host did not answer in time" } }),
        timeoutMs,
      );
    });
    this.#dispatchDesktopRequest(() =>
      this.#guardReply(request, () =>
        this.#handleDesktopRequest(request, Buffer.from(JSON.stringify(request)), origin),
      ),
    );
    try {
      const message = await reply;
      if (isRecord(message) && "result" in message) {
        return { result: (message.result ?? null) as JsonValue };
      }
      const error = isRecord(message) && isRecord(message.error) ? message.error : undefined;
      return {
        error: {
          code: typeof error?.code === "number" ? error.code : -32603,
          message: typeof error?.message === "string" ? error.message : "Host request failed",
        },
      };
    } finally {
      clearTimeout(timer);
      this.#consoleReplies.delete(id);
    }
  }

  /** Public client operations stay on this owner and never fall through to official Codex. */
  handleClientRequest(method: string, input: unknown): Promise<ConsoleHostReply> {
    return this.#client.handleClientRequest(method, input);
  }

  /** Absolute, bounded state; capture fields and delivery cursor without yielding.
   * Notifications are invalidations, not text deltas to replay over this snapshot.
   */
  clientSnapshot(
    threadId: string,
    options: ClientSnapshotOptions = {},
  ): Promise<ClientThreadSnapshot> {
    return this.#client.clientSnapshot(threadId, options);
  }

  respondClient(input: ClientChannelResponse): Promise<{ resolved: boolean }> {
    return this.#client.respondClient(input);
  }

  #forgetPendingOfficialTurnStarts(threadId: string): void {
    for (const [requestId, pendingThreadId] of this.#pendingOfficialTurnStarts) {
      if (pendingThreadId === threadId) this.#pendingOfficialTurnStarts.delete(requestId);
    }
  }

  async #forwardDesktop(): Promise<void> {
    for await (const frame of readLfFrames(this.#options.desktopInput)) {
      const parsed = parseJsonFrame(frame);
      try {
        if (await this.#options.sharedThreads?.respond(parsed)) continue;
      } catch (error) {
        // An expired remote interaction must not tear down this GUI's native
        // connection or its unrelated local Sessions.
        this.#diagnose(error);
        continue;
      }
      if (isRecord(parsed) && parsed.method === "initialized" && !("id" in parsed)) {
        continue;
      }
      if (await this.#handleDesktopApprovalResponse(parsed)) continue;
      if (await this.#handleDesktopQuestionResponse(parsed)) continue;
      const requestResult = jsonRpcRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        await this.#forwardOfficialNonRequest(parsed, frame).catch(() => {
          this.#diagnose("Official notification or server reply could not be delivered");
        });
        continue;
      }
      const request = requestResult.data;
      if (request.method === "initialize") {
        try {
          const nativeGeneration =
            this.#officialRuntimeScope.gate.phase === "ready"
              ? this.#officialRuntimeScope.owner.generation
              : undefined;
          // Native exclusions are immutable after initialization. Wait for the statistics
          // phase to settle (including loader failures/timeouts), not an arbitrary race and
          // not the much larger Session plugin registry.
          void this.#waitForPlugins();
          await this.#usagePluginsReady;
          const params = requestObject(request);
          const options = this.#observedSessionUsage.requestOptions("initialize", params);
          const nativeParams = options ? { ...params, ...options } : params;
          const response = await this.#officialRuntime.initializeProtocol(nativeParams);
          if (!isRecord(response.error)) this.#observedSessionUsage.initialized(nativeParams);
          await this.#writer.json({ ...response, id: request.id });
          this.#nativeAccountObserver?.initialized(nativeGeneration);
        } catch (error) {
          await this.#writer.json(rpcError(request, -32087, errorMessage(error)));
        }
        continue;
      }
      const threadId =
        isRecord(request.params) && typeof request.params.threadId === "string"
          ? request.params.threadId
          : undefined;
      this.#dispatchDesktopRequest(() =>
        this.#desktopRequests.run(threadId, () =>
          this.#externalRuntime.idleRelease.runOperation(threadId, () =>
            this.#guardReply(request, () => this.#handleDesktopRequest(request, frame, "desktop")),
          ),
        ),
      );
    }
    this.#desktopInputEnded = true;
    this.#externalRuntime.idleRelease.disable();
    // Cancel loading before draining requests that may be waiting for it.
    this.#pluginLoadAbort.abort();
    await this.#desktopRequests.drain();
    this.#externalSteering.close();
    if (this.#drainActiveWorkOnInputEnd) await this.#waitForActiveWorkToDrain();
    await this.#closeOfficialRuntime();
  }

  /**
   * A handler failure must still answer the request; otherwise Codex Desktop waits forever.
   * Requests already answered or handed to native Codex are left alone. Work a handler detaches
   * through {@link #dispatchDesktopReply} keeps its own guard.
   */
  async #guardReply(request: JsonRpcRequest, run: () => Promise<void>): Promise<void> {
    const guard = { answered: false };
    let guards = this.#replyGuards.get(request.id);
    if (!guards) {
      guards = new Set();
      this.#replyGuards.set(request.id, guards);
    }
    guards.add(guard);
    try {
      await run();
    } catch (error) {
      this.#diagnose(error);
      if (!guard.answered) {
        await this.#writer
          .json(rpcError(request, -32603, "codexhost could not handle the request"))
          .catch((writeError: unknown) => this.#diagnose(writeError));
      }
    } finally {
      guards.delete(guard);
      if (guards.size === 0) this.#replyGuards.delete(request.id);
    }
  }

  #markDesktopRequestAnswered(id: unknown): void {
    for (const guard of this.#replyGuards.get(id) ?? []) guard.answered = true;
  }

  #noteDesktopReply(value: JsonValue): void {
    if (isRecord(value) && "id" in value && !("method" in value)) {
      this.#markDesktopRequestAnswered(value.id);
    }
  }

  /** Detaches work that answers `request`, keeping the failure fallback. */
  #dispatchDesktopReply(
    request: JsonRpcRequest,
    run: () => Promise<void>,
    threadId?: string,
  ): void {
    this.#dispatchDesktopRequest(() => this.#guardReply(request, run), threadId);
  }

  async #handleDesktopRequest(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    origin: HostRequestOrigin,
  ): Promise<void> {
    if (this.#closeRequested) return;
    if (
      request.method === RUNTIME_STATUS_METHOD ||
      request.method === REMOTE_UPDATE_METHOD ||
      request.method === REMOTE_SSH_SETUP_METHOD
    ) {
      const maintenance = this.#options.runtimeMaintenance;
      try {
        if (!maintenance)
          throw new Error("Runtime version management is unavailable in this build");
        const result =
          request.method === RUNTIME_STATUS_METHOD
            ? await maintenance.status()
            : request.method === REMOTE_SSH_SETUP_METHOD
              ? await maintenance.setupSsh(remoteSshSetupParamsSchema.parse(request.params))
              : await maintenance.start(remoteUpdateParamsSchema.parse(request.params).version);
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      } catch (error) {
        await this.#writer.json(rpcError(request, -32090, errorMessage(error)));
      }
      return;
    }
    if (this.#options.runtimeMaintenance?.blocked) {
      await this.#writer.json(
        rpcError(request, -32090, "Remote service is updating; reconnect shortly"),
      );
      return;
    }
    const externalHarness = this.#desktopThreadHarness(request, origin);
    if (externalHarness !== undefined) {
      await this.#waitForPluginSurfaces();
      if (!this.#visibleOn("desktop", externalHarness)) {
        const threadId = String((request.params as JsonObject).threadId);
        await this.#writer.json(rpcError(request, -32600, `thread not found: ${threadId}`));
        return;
      }
    }
    if (request.method === DELEGATION_READ_METHOD) {
      const parsed = delegationReadParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        await this.#writer.json(rpcError(request, -32602, "Invalid Thread read request"));
        return;
      }
      const shared = await this.#options.sharedThreads?.route(request);
      if (shared) {
        await this.#writer.json(shared);
        return;
      }
      await this.#waitForPlugins();
      const result = await this.#delegationCoordinator.read({
        threadId: parsed.data.threadId,
        view: parsed.data.view,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      return;
    }
    if (this.#options.externalOnly && request.method === "codexhost/shared-threads/placements") {
      await this.#writer.json(
        rpcEnvelope(request, {
          result: jsonValueSchema.parse(await this.#repository.listSectionPlacements()),
        }),
      );
      return;
    }
    if (
      this.#options.sharedThreads &&
      (request.method.startsWith("thread/") ||
        request.method.startsWith("turn/") ||
        request.method.startsWith("codexhost/thread/") ||
        request.method.startsWith("codexhost/harness/") ||
        this.#options.sharedThreads.handlesControl(request.method))
    ) {
      try {
        const reply = await this.#options.sharedThreads.route(request);
        if (reply) {
          await this.#writer.json(reply);
          return;
        }
      } catch (error) {
        await this.#writer.json(rpcError(request, -32090, errorMessage(error)));
        return;
      }
    }
    if (
      this.#options.externalOnly &&
      !(
        request.method.startsWith("thread/") ||
        request.method.startsWith("turn/") ||
        request.method.startsWith("codexhost/thread/") ||
        request.method.startsWith("codexhost/harness/") ||
        request.method === LOADED_SESSIONS_METHOD ||
        request.method === IDLE_RELEASE_SETTINGS_METHOD ||
        request.method === USAGE_STATISTICS_METHOD ||
        // Settings requests from Web clients; the shared service owns these handlers too.
        request.method.startsWith("codexhost/account/") ||
        request.method.startsWith("codexhost/update/") ||
        isModelPriceOverridesMethod(request.method)
      )
    ) {
      await this.#writer.json(
        rpcError(request, -32601, "Method is unavailable on the shared Thread service"),
      );
      return;
    }
    if (this.#externalPrewarms.observe(request)) {
      await this.#writer.json(
        rpcError(request, -32075, "External prewarm close was not confirmed"),
      );
      return;
    }
    if (request.method === THREAD_PREWARM_DISCARD_METHOD) {
      const parsed = threadPrewarmDiscardParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        await this.#writer.json(rpcError(request, -32602, "Invalid prewarm discard request"));
        return;
      }
      try {
        const discarded = await this.#externalPrewarms.discard(parsed.data.threadId, {
          get: (id) => this.#externalRuntime.get(id),
          remove: async (thread) => {
            await this.#repository.removeThread(thread.id);
            this.#externalRuntime.remove(thread.id);
            this.#routeObservationTracker.forgetThread(thread.id);
          },
        });
        await this.#writer.json(rpcEnvelope(request, { result: { discarded } }));
      } catch (error) {
        this.#diagnose(error);
        await this.#writer.json(rpcError(request, -32075, "External prewarm could not close"));
      }
      return;
    }
    if (await this.#desktopControl.handle(request, origin)) return;
    if (await this.#threadRouting.handle(request, frame, origin)) return;
    await this.#forwardOfficialRequest(
      request,
      await this.#rewriteOfficialDelegationMentions(request, frame),
    );
  }

  /** Native Codex Turns: turn `#` delegation chips into an explicit Skill-backed request. */
  async #rewriteOfficialDelegationMentions(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<Buffer<ArrayBufferLike>> {
    if (request.method !== "turn/start" && request.method !== "turn/steer") return frame;
    if (!isRecord(request.params) || !Array.isArray(request.params.input)) return frame;
    const input = request.params.input as JsonValue[];
    if (
      !input.some(
        (item) =>
          isRecord(item) &&
          typeof item.text === "string" &&
          item.text.includes(DELEGATION_MENTION_PATH_PREFIX),
      )
    ) {
      return frame;
    }
    const rewritten = rewriteDelegationMentionInput(input, await managedDelegationSkillReference());
    if (!rewritten) return frame;
    return encodeJsonFrame({
      ...(request as unknown as JsonObject),
      params: { ...(request.params as JsonObject), input: rewritten },
    });
  }

  async #forwardOfficialNonRequest(
    value: JsonValue,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<void> {
    if (this.#options.externalOnly) return;
    const response = isRecord(value) ? value : null;
    const request =
      response && (typeof response.id === "string" || typeof response.id === "number")
        ? this.#officialServerRequests.get(response.id)
        : null;
    if (request !== undefined && response) {
      this.#officialServerRequests.delete(response.id as JsonRpcId);
      await this.#officialRuntime.send({
        ...response,
        id: request,
      });
      return;
    }
    await this.#officialRuntime.sendFrame(frame);
  }

  async #forwardOfficialRequest(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
  ): Promise<void> {
    if (this.#options.externalOnly) {
      await this.#writer.json(
        rpcError(request, -32601, "Shared Thread service only handles external Harness Threads"),
      );
      return;
    }
    try {
      // Optional plugin-owned notification subscription options. Never wait for plugin startup
      // here: enhancement must not delay native commands or interrupt handling.
      const options = isRecord(request.params)
        ? this.#observedSessionUsage.requestOptions(request.method, request.params)
        : null;
      if (options) {
        const original = parseJsonFrame(frame);
        if (isRecord(original))
          frame = encodeJsonFrame({
            ...original,
            params: { ...(isRecord(original.params) ? original.params : {}), ...options },
          });
      }
      await this.#officialRuntime.sendFrame(frame);
      this.#markDesktopRequestAnswered(request.id);
    } catch {
      if (request.method === "turn/start") {
        this.#pendingOfficialTurnStarts.delete(request.id);
        this.#signalActiveWorkChanged();
      }
      await this.#writer.json(
        rpcError(request, -32001, "Official request failed; retry explicitly"),
      );
    }
  }

  async #handleOfficialOutput(input: {
    accountId: string;
    frame: Buffer<ArrayBufferLike>;
    value: JsonValue;
  }): Promise<void> {
    if (this.#options.externalOnly) {
      // Native children created through Delegation still have a native owner
      // and lifecycle. Their rendering stays on the GUI's native connection.
      await this.#observeOfficialTurnLifecycle(input.value);
      return;
    }
    const parsed = input.value;
    const observedAtMs = Date.now();
    this.#observeOfficialTurnStartResponse(parsed);
    let forwarded: JsonValue = parsed;
    if (isRecord(parsed) && typeof parsed.method === "string" && "id" in parsed) {
      const originalId = parsed.id;
      if (typeof originalId === "string" || typeof originalId === "number") {
        const forwardedId = `codexhost:official:${++this.#nextOfficialServerRequestId}`;
        this.#officialServerRequests.set(forwardedId, originalId);
        forwarded = { ...parsed, id: forwardedId };
      }
    }
    const accountScopedNotification =
      isRecord(parsed) &&
      typeof parsed.method === "string" &&
      (parsed.method === "account/updated" || parsed.method.startsWith("account/rateLimits/"));
    if (accountScopedNotification) {
      if (parsed.method === "account/updated") this.#officialRateLimits.reset(input.accountId);
    }
    const rateLimits = observeCodexRateLimits(parsed);
    if (rateLimits) this.#officialRateLimits.observe(input.accountId, rateLimits);
    // Owner already rejects retired generations.
    try {
      await this.#observeOfficialTurnLifecycle(parsed);
    } catch (error) {
      this.#diagnose(error);
    }
    this.#routeObservationTracker.bindOfficialResponse(parsed);
    const privateTelemetry =
      isRecord(parsed) &&
      typeof parsed.method === "string" &&
      !("id" in parsed) &&
      !this.#observedSessionUsage.shouldForwardNotification(parsed);
    if (!privateTelemetry) {
      if (forwarded === parsed) await this.#writer.frame(input.frame);
      else await this.#writer.json(forwarded);
    }
    // Plugin startup and history I/O must never delay the official protocol. Promise
    // callbacks preserve observation order and the original receipt timestamps.
    void (this.#usagePluginsReady ?? Promise.resolve())
      .then(async () => {
        for (const threadId of this.#observedSessionUsage.observe(parsed, observedAtMs)) {
          await this.#writer.json({ method: THREAD_USAGE_UPDATED_METHOD, params: { threadId } });
        }
      })
      .catch((error: unknown) => this.#diagnose(error));
    this.#nativeAccountObserver?.observe(parsed);
    const deletedProjectId = observeDeletedProject(parsed);
    if (deletedProjectId) {
      await this.#clearDeletedProjectAssignments(deletedProjectId).catch((error: unknown) =>
        this.#diagnose(error),
      );
    }
  }

  async #requestOfficial(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#options.externalOnly) {
      // The independent owner starts native Codex only when native metadata or
      // an explicit native Delegation needs it, not when Web merely connects.
      await this.#officialRuntime.initialize();
      await this.#officialRuntime.initializeProtocol({
        clientInfo: { name: "codexhost-shared-threads", version: "1" },
        capabilities: { experimentalApi: true },
      });
    }
    return this.#officialRuntime.request(method, params);
  }

  #inspectHarnessAccount(
    adapter: HarnessAdapter,
    refresh = false,
  ): Promise<HarnessAccountInspectResult> {
    return this.#accountInspections.inspect(adapter, this.#pluginDescriptors, refresh);
  }

  async #currentCodexAccountId(): Promise<string | null> {
    return this.#accountControl.currentAccountId();
  }

  async #codexAccountSnapshot() {
    return this.#accountControl.refresh?.() ?? this.#accountControl.snapshot();
  }

  async #handleCodexAccountRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (request.method === "codexhost/account/usage/inspect") {
        const { accountId, refresh } = codexAccountUsageParamsSchema.parse(requestObject(request));
        if (accountId !== (await this.#currentCodexAccountId()))
          throw new Error("Unknown Codex Account");
        const observation = await this.#refreshOfficialRateLimits(accountId, refresh === true);
        const usage = this.#officialRateLimits.get(accountId);
        const accountCredits = this.#officialAccountCredits(accountId);
        const result = codexAccountUsageResultSchema.parse({
          accountId,
          usage,
          ...(accountCredits ? { accountCredits } : {}),
          freshness: observation.status === "live" ? ("live" as const) : ("cached" as const),
          observedAt: observation.observedAt,
        });
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        return;
      }
      await this.#writer.json(
        rpcEnvelope(request, {
          result: jsonValueSchema.parse(await this.#codexAccountSnapshot()),
        }),
      );
    } catch (error) {
      const failure = codexAccountRpcError(error);
      await this.#writer.json(rpcError(request, failure.code, failure.message));
    }
  }

  async #observeOfficialTurnLifecycle(value: JsonValue): Promise<void> {
    if (!isRecord(value) || !isRecord(value.params)) return;
    const params = value.params;
    if (value.method === "turn/started" && typeof params.threadId === "string") {
      const turn = isRecord(params.turn) ? params.turn : null;
      if (turn && typeof turn.id === "string") {
        this.#forgetPendingOfficialTurnStarts(params.threadId);
        this.#activeOfficialTurns.set(params.threadId, turn.id);
      }
    }
    if (value.method === "turn/completed" && typeof params.threadId === "string") {
      this.#forgetPendingOfficialTurnStarts(params.threadId);
      this.#activeOfficialTurns.delete(params.threadId);
      this.#signalActiveWorkChanged();
      const delegation = await this.#repository.getDelegationByChild(
        hostThreadIdSchema.parse(params.threadId),
      );
      const turn = isRecord(params.turn) ? params.turn : null;
      const status =
        turn?.status === "failed"
          ? "failed"
          : turn?.status === "interrupted" || turn?.status === "cancelled"
            ? "interrupted"
            : "completed";
      if (this.#pendingOfficialDelegationThreads.has(params.threadId)) {
        this.#pendingOfficialTerminalStatuses.set(params.threadId, status);
      }
      if (delegation) {
        await this.#repository.setDelegationStatus(delegation.delegationId, status);
      }
    }
  }

  async #canHandleDelegationStart(input: DelegationStartInput): Promise<boolean> {
    if (input.parentThreadId) return this.#ownsDelegationThread(input.parentThreadId);
    const externalActive = this.#externalRuntime.values().some((thread) => thread.running);
    return externalActive || this.#activeOfficialTurns.size > 0;
  }

  async #ownsDelegationThread(threadId: string): Promise<boolean> {
    if (await this.#options.sharedDelegation?.ownsThread(threadId)) return false;
    if (
      this.#options.sharedThreads?.options.delegateCreates &&
      (await this.#options.sharedThreads.ownership([threadId])).has(threadId)
    )
      return false;
    if (
      this.#externalRuntime.get(threadId) !== undefined ||
      this.#activeOfficialTurns.has(threadId)
    ) {
      return true;
    }
    const parsed = hostThreadIdSchema.safeParse(threadId);
    if (!parsed.success) return false;
    const [thread, childDelegation, delegation] = await Promise.all([
      this.#repository.find(parsed.data),
      this.#repository.getDelegationByChild(parsed.data),
      this.#repository.getDelegation(parsed.data),
    ]);
    return thread !== null || childDelegation !== null || delegation !== null;
  }

  async #readOfficialThreadMetadata(threadId: string): Promise<{ cwd?: string; title?: string }> {
    const response = await this.#requestOfficial("thread/read", { threadId, includeTurns: false });
    if (isRecord(response.error)) return {};
    const result = isRecord(response.result) ? response.result : null;
    const thread = result && isRecord(result.thread) ? result.thread : null;
    if (!thread) return {};
    const title =
      typeof thread.name === "string" && thread.name.trim() ? thread.name : thread.preview;
    return {
      ...(typeof thread.cwd === "string" && thread.cwd.trim() ? { cwd: thread.cwd } : {}),
      ...(typeof title === "string" && title.trim() ? { title } : {}),
    };
  }

  async #inspectOfficialDelegationTarget(
    input: HarnessInspectInput,
  ): Promise<HarnessInspectResult> {
    const response = await this.#requestOfficial("model/list", {});
    if (isRecord(response.error)) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        typeof response.error.message === "string"
          ? response.error.message
          : "Official Model catalog could not be read",
      );
    }
    const result = isRecord(response.result) ? response.result : null;
    const data = result && Array.isArray(result.data) ? result.data : [];
    const thinkingById = new Map<ReturnType<typeof harnessThinkingOptionIdSchema.parse>, string>();
    const models = data.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.model !== "string" || !candidate.model.trim()) {
        return [];
      }
      const supportedThinkingOptionIds = Array.isArray(candidate.supportedReasoningEfforts)
        ? candidate.supportedReasoningEfforts.flatMap((option) => {
            if (
              !isRecord(option) ||
              typeof option.reasoningEffort !== "string" ||
              !option.reasoningEffort.trim()
            ) {
              return [];
            }
            const id = harnessThinkingOptionIdSchema.safeParse(option.reasoningEffort);
            if (!id.success) return [];
            thinkingById.set(
              id.data,
              typeof option.description === "string" && option.description.trim()
                ? option.description
                : option.reasoningEffort,
            );
            return [id.data];
          })
        : [];
      return [
        {
          ref: encodeOfficialCodexModelRef(candidate.model),
          label:
            typeof candidate.displayName === "string" && candidate.displayName.trim()
              ? candidate.displayName
              : candidate.model,
          ...(supportedThinkingOptionIds.length > 0 ? { supportedThinkingOptionIds } : {}),
        },
      ];
    });
    const defaultEntry = data.find(
      (candidate) => isRecord(candidate) && candidate.isDefault === true,
    );
    const defaultModel =
      isRecord(defaultEntry) && typeof defaultEntry.model === "string"
        ? encodeOfficialCodexModelRef(defaultEntry.model)
        : undefined;
    return {
      harnessId: input.harnessId,
      inspection: {
        status: "ready",
        catalog: {
          models,
          ...(defaultModel ? { defaultModel } : {}),
          thinkingOptions: [...thinkingById].map(([id, label]) => ({ id, label })),
        },
        capabilities: {
          configuration: {
            selectModel: models.length > 0,
            selectThinkingOption: thinkingById.size > 0,
            selectPermissionMode: false,
            permissionModeScope: "live",
          },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        },
      },
    };
  }

  async #startOfficialDelegation(
    input: DelegationStartInput & { parentThreadId: string; cwd: string; title: string },
  ): Promise<DelegationStartResult> {
    let requestedModel: HarnessModelRef | undefined;
    try {
      requestedModel = input.model ? canonicalizeOfficialCodexModelRef(input.model) : undefined;
    } catch {
      throw new DelegationControlError("INVALID_ARGUMENT", "Official Model Ref is invalid");
    }
    const nativeModelId = requestedModel ? decodeOfficialCodexModelRef(requestedModel) : undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          task: input.task,
          cwd: input.cwd,
          modelId: requestedModel?.id ?? null,
          thinkingOptionId: input.thinkingOptionId ?? null,
        }),
      )
      .digest("hex");
    const existing = input.requestId
      ? await this.#repository.findDelegationByRequest(input.requestId)
      : await this.#repository.findRecentDelegation({
          parentHostThreadId: hostThreadIdSchema.parse(input.parentThreadId),
          targetHarnessId: harnessIdSchema.parse("codex"),
          taskDigest: digest,
          since: new Date(Date.now() - 30_000),
        });
    if (
      existing &&
      input.requestId &&
      (existing.targetHarnessId !== "codex" || existing.taskDigest !== digest)
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Request ID is already associated with another Delegation configuration",
      );
    }
    if (existing) {
      const turnId = this.#activeOfficialTurns.get(existing.childHostThreadId) ?? "pending";
      return {
        delegationId: existing.delegationId,
        threadId: existing.childHostThreadId,
        turnId,
        harnessId: "codex",
        deepLink: `codex://threads/${existing.childHostThreadId}`,
        status: existing.status,
        next: {
          read: `codexhost thread read ${existing.childHostThreadId}`,
          wait: `codexhost thread wait ${existing.childHostThreadId} --timeout-ms 30000`,
        },
      };
    }
    if (requestedModel || input.thinkingOptionId) {
      const inspected = await this.#inspectOfficialDelegationTarget({
        harnessId: "codex",
        cwd: input.cwd,
      });
      if (inspected.inspection.status !== "ready") {
        throw new DelegationControlError(
          "DELEGATION_FAILED",
          "Official Model catalog is unavailable",
        );
      }
      if (
        requestedModel &&
        !inspected.inspection.catalog.models.some(
          (candidate) => candidate.ref.id === requestedModel.id,
        )
      ) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Official Model is unavailable", {
          validModelIds: inspected.inspection.catalog.models.map((candidate) => candidate.ref.id),
        });
      }
      if (input.thinkingOptionId) {
        const selectedModel = requestedModel ?? inspected.inspection.catalog.defaultModel;
        const selectedEntry = selectedModel
          ? inspected.inspection.catalog.models.find(
              (candidate) => candidate.ref.id === selectedModel.id,
            )
          : undefined;
        const validThinkingOptionIds = selectedEntry?.supportedThinkingOptionIds ?? [];
        if (!validThinkingOptionIds.includes(input.thinkingOptionId)) {
          throw new DelegationControlError(
            "INVALID_ARGUMENT",
            "Official Thinking option is unavailable for the selected Model",
            { validThinkingOptionIds },
          );
        }
      }
    }
    const started = await this.#officialRuntime.request("thread/start", {
      cwd: input.cwd,
      ...(nativeModelId ? { model: nativeModelId } : {}),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      historyMode: "paginated",
    });
    const startedResult = isRecord(started.result) ? started.result : null;
    const thread = startedResult && isRecord(startedResult.thread) ? startedResult.thread : null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    if (!threadId) throw new Error("Official thread/start returned no Thread identity");
    this.#pendingOfficialDelegationThreads.add(threadId);
    let turnId: string;
    try {
      // The title is presentation only: a failure keeps the default title and still delivers the task.
      await this.#requestOfficial("thread/name/set", { threadId, name: input.title }).catch(
        () => undefined,
      );
      const turn = await this.#requestOfficial("turn/start", {
        threadId,
        input: [{ type: "text", text: input.task }],
        ...(nativeModelId ? { model: nativeModelId } : {}),
        ...(input.thinkingOptionId ? { effort: input.thinkingOptionId } : {}),
      });
      const turnResult = isRecord(turn.result) ? turn.result : null;
      const turnValue = turnResult && isRecord(turnResult.turn) ? turnResult.turn : null;
      const parsedTurnId = turnValue && typeof turnValue.id === "string" ? turnValue.id : null;
      if (!parsedTurnId) throw new Error("Official turn/start returned no Turn identity");
      turnId = parsedTurnId;
    } catch (error) {
      this.#pendingOfficialDelegationThreads.delete(threadId);
      this.#pendingOfficialTerminalStatuses.delete(threadId);
      await this.#requestOfficial("thread/delete", { threadId }).catch(() => undefined);
      throw error;
    }
    this.#activeOfficialTurns.set(threadId, turnId);
    const delegationId = hostThreadIdSchema.parse(randomUUID());
    try {
      const source = await this.#repository.find(input.parentThreadId);
      const pendingTerminal = this.#pendingOfficialTerminalStatuses.get(threadId);
      await this.#repository.createDelegation({
        delegationId,
        parentHostThreadId: hostThreadIdSchema.parse(input.parentThreadId),
        childHostThreadId: hostThreadIdSchema.parse(threadId),
        sourceHarnessId: source?.harnessId ?? harnessIdSchema.parse("codex"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        status: pendingTerminal ?? "running",
        ...(input.requestId ? { requestId: input.requestId } : {}),
        taskDigest: digest,
      });
      return {
        delegationId,
        threadId,
        turnId,
        harnessId: "codex",
        deepLink: `codex://threads/${threadId}`,
        status: pendingTerminal ?? "running",
        cwd: thread && typeof thread.cwd === "string" ? thread.cwd : input.cwd,
        ...(requestedModel || input.thinkingOptionId
          ? {
              configuration: {
                requested: {
                  ...(requestedModel ? { model: requestedModel } : {}),
                  ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
                },
                effective: {
                  ...(startedResult && typeof startedResult.model === "string"
                    ? { effectiveModel: encodeOfficialCodexModelRef(startedResult.model) }
                    : {}),
                },
              },
            }
          : {}),
        next: {
          read: `codexhost thread read ${threadId}`,
          wait: `codexhost thread wait ${threadId} --timeout-ms 30000`,
        },
      };
    } catch (error) {
      this.#activeOfficialTurns.delete(threadId);
      this.#signalActiveWorkChanged();
      await this.#requestOfficial("thread/delete", { threadId }).catch(() => undefined);
      throw error;
    } finally {
      this.#pendingOfficialDelegationThreads.delete(threadId);
      this.#pendingOfficialTerminalStatuses.delete(threadId);
    }
  }

  async #sendOfficialDelegationThread(input: ThreadSendInput): Promise<ThreadSendResult> {
    if (!input.message?.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Message must not be empty");
    }
    if (this.#activeOfficialTurns.has(input.threadId)) {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }
    const current = await this.#requestOfficial("thread/read", {
      threadId: input.threadId,
      includeTurns: true,
    });
    if (isRecord(current.error)) throw officialThreadReadError(current.error);
    if (!isRecord(current.result)) {
      throw new DelegationControlError("INTERNAL_ERROR", "Official Thread read returned no result");
    }
    const currentThread = isRecord(current.result.thread) ? current.result.thread : null;
    if (officialThreadBusy(currentThread)) {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }
    // Read stays idle after unsubscribe and does not resubscribe. Resume does, and
    // excludeTurns keeps paginated history out of the response without replacing config.
    const resumed = await this.#requestOfficial("thread/resume", {
      threadId: input.threadId,
      excludeTurns: true,
    });
    if (isRecord(resumed.error) || !isRecord(resumed.result)) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        isRecord(resumed.error) && typeof resumed.error.message === "string"
          ? resumed.error.message
          : "Official Thread resume failed",
        { notStarted: true },
      );
    }
    const resumedThread = isRecord(resumed.result.thread) ? resumed.result.thread : null;
    if (!resumedThread || resumedThread.id !== input.threadId) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        "Official Thread resume did not return the requested Thread",
        { notStarted: true },
      );
    }
    if (officialThreadBusy(resumedThread)) {
      throw new DelegationControlError("THREAD_BUSY", "Thread already has an active Turn");
    }
    if (!isRecord(resumedThread.status) || resumedThread.status.type !== "idle") {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        "Official Thread is not idle after resume",
        { notStarted: true },
      );
    }
    const response = await this.#requestOfficial("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.message }],
    });
    if (isRecord(response.error)) {
      // app-server answered turn/start with an error, so no Turn was started.
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        typeof response.error.message === "string" ? response.error.message : "Turn start failed",
        { notStarted: true },
      );
    }
    const result = isRecord(response.result) ? response.result : null;
    const turn = result && isRecord(result.turn) ? result.turn : null;
    const turnId = turn && typeof turn.id === "string" ? turn.id : null;
    if (!turnId) throw new Error("Official turn/start returned no Turn identity");
    this.#activeOfficialTurns.set(input.threadId, turnId);
    return {
      threadId: input.threadId,
      turnId,
      harnessId: "codex",
      status: "running",
      next: {
        read: `codexhost thread read ${input.threadId}`,
        wait: `codexhost thread wait ${input.threadId} --timeout-ms 30000`,
      },
    };
  }

  async #cancelOfficialDelegationThread(input: ThreadCancelInput): Promise<ThreadCancelResult> {
    let turnId = this.#activeOfficialTurns.get(input.threadId);
    if (!turnId) {
      const current = await this.#requestOfficial("thread/read", {
        threadId: input.threadId,
        includeTurns: true,
      });
      if (isRecord(current.error) || !isRecord(current.result)) {
        throw new DelegationControlError("THREAD_NOT_FOUND", "Official Thread was not found");
      }
      const currentThread = isRecord(current.result.thread) ? current.result.thread : null;
      const currentTurns =
        currentThread && Array.isArray(currentThread.turns) ? currentThread.turns : [];
      const latestTurn = currentTurns.at(-1);
      if (
        isRecord(latestTurn) &&
        typeof latestTurn.id === "string" &&
        (latestTurn.status === "inProgress" || latestTurn.status === "running")
      ) {
        turnId = latestTurn.id;
        this.#activeOfficialTurns.set(input.threadId, turnId);
      } else {
        return { threadId: input.threadId, turnId: null, harnessId: "codex", cancelled: false };
      }
    }
    const response = await this.#requestOfficial("turn/interrupt", {
      threadId: input.threadId,
      turnId,
    });
    if (isRecord(response.error)) {
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        typeof response.error.message === "string" ? response.error.message : "Turn cancel failed",
      );
    }
    return { threadId: input.threadId, turnId, harnessId: "codex", cancelled: true };
  }

  async #readOfficialDelegationThread(input: ThreadReadInput): Promise<DelegationThreadSnapshot> {
    const response = await this.#requestOfficial("thread/read", {
      threadId: input.threadId,
      includeTurns: true,
    });
    if (isRecord(response.error)) throw officialThreadReadError(response.error);
    const result = isRecord(response.result) ? response.result : null;
    const thread = result && isRecord(result.thread) ? result.thread : null;
    if (!thread)
      throw new DelegationControlError("INTERNAL_ERROR", "Official Thread read returned no Thread");
    const turns = Array.isArray(thread.turns)
      ? thread.turns.filter((turn): turn is JsonObject => isRecord(turn))
      : [];
    const running =
      this.#activeOfficialTurns.has(input.threadId) ||
      (isRecord(thread.status) && thread.status.type === "active");
    const snapshot = projectDelegationThreadSnapshot({
      threadId: input.threadId,
      harnessId: "codex",
      thread,
      turns,
      running,
      view: input.view,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const delegation = await this.#repository.getDelegationByChild(
      hostThreadIdSchema.parse(input.threadId),
    );
    if (delegation && delegation.status !== snapshot.status) {
      await this.#repository.setDelegationStatus(delegation.delegationId, snapshot.status);
    }
    return snapshot;
  }

  async #listDelegationThreads(input: ThreadListInput): Promise<DelegationThreadListResult> {
    const [sortKey, sortDirection] = input.sort.split("-") as [string, "asc" | "desc"];
    const request: JsonRpcRequest = {
      id: `codexhost:delegation-list:${randomUUID()}`,
      method: "thread/list",
      params: {
        cwd: input.cwd ? [input.cwd] : null,
        limit: input.limit,
        cursor: input.cursor ?? null,
        sortKey: `${sortKey}_at`,
        sortDirection,
      },
    };
    const decoded = decodeThreadListRequest(request);
    if (!decoded) throw new Error("Delegation thread/list request could not be decoded");
    const records = await this.#repository.list();
    const result = await aggregateThreadList({
      query: decoded,
      records,
      ...(this.#options.sharedThreads
        ? { sharedThreads: await this.#options.sharedThreads.list(decoded.params) }
        : {}),
      runtimeFor: (threadId) => {
        const thread = this.#externalRuntime.get(threadId);
        return thread ? { running: thread.running } : null;
      },
      requestOfficialPage: async (params) =>
        officialThreadListPageFromResponse(await this.#requestOfficial("thread/list", params)),
    });
    return {
      threads: result.data.flatMap((entry) => {
        if (typeof entry.id !== "string") return [];
        const record = records.find((candidate) => candidate.hostThreadId === entry.id);
        const status =
          isRecord(entry.status) && entry.status.type === "active" ? "running" : "completed";
        return [
          {
            threadId: entry.id,
            harnessId: record ? (record.harnessId as ExternalHarnessId) : "codex",
            deepLink: `codex://threads/${entry.id}`,
            status,
            ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
            ...(typeof entry.name === "string"
              ? { title: entry.name }
              : typeof entry.preview === "string"
                ? { title: entry.preview }
                : {}),
          },
        ];
      }),
      nextCursor: result.nextCursor,
    };
  }

  async #listThreads(
    request: JsonRpcRequest,
    listRequest: DecodedThreadListRequest,
    origin: HostRequestOrigin,
  ): Promise<void> {
    try {
      await this.#waitForPluginSurfaces();
      const [records, placements] = await Promise.all([
        this.#repository.list(),
        this.#repository.listSectionPlacements(),
      ]);
      const placementById = new Map(
        placements.map((entry) => [entry.hostThreadId as string, entry]),
      );
      const result = await aggregateThreadList({
        query: listRequest,
        records: this.#recordsFor(origin, records),
        ...(this.#options.sharedThreads
          ? {
              sharedThreads: await this.#options.sharedThreads.list(listRequest.params),
            }
          : {}),
        runtimeFor: (threadId) => this.#listRuntimeState(threadId),
        placementOf: (threadId) => placementById.get(threadId),
        requestOfficialPage: async (params) =>
          this.#options.externalOnly
            ? { data: [], nextCursor: null, backwardsCursor: null }
            : officialThreadListPageFromResponse(
                await this.#officialRuntime.request("thread/list", params),
              ),
      });
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      if (error instanceof OfficialThreadListError) {
        await this.#writer.json(rpcEnvelope(request, { error: error.rpcError }));
        return;
      }
      await this.#writer.json(rpcError(request, -32082, "Thread list aggregation failed"));
      this.#diagnose(error);
    }
  }

  #listRuntimeState(threadId: string): { running: boolean } | null {
    const subagentStatus = this.#subagentThreadStatuses.get(threadId);
    if (subagentStatus) return { running: subagentStatus === "active" };
    const thread = this.#externalRuntime.get(threadId);
    return thread ? { running: thread.running } : null;
  }

  /** `section_position` lists merge External section placements into the official order. */
  async #listSectionThreads(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    query: DecodedThreadListRequest,
    origin: HostRequestOrigin,
  ): Promise<void> {
    try {
      await this.#waitForPluginSurfaces();
      const [records, localPlacements, sharedPlacements, sharedThreads] = await Promise.all([
        this.#repository.list(),
        this.#repository.listSectionPlacements(),
        this.#options.sharedThreads?.placements() ?? [],
        this.#options.sharedThreads?.list(query.params) ?? [],
      ]);
      const sharedIds = new Set(sharedPlacements.map((p) => p.hostThreadId));
      const placements = [
        ...localPlacements.filter((p) => !sharedIds.has(p.hostThreadId)),
        ...sharedPlacements,
      ];
      const placementById = new Map(
        placements.map((entry) => [entry.hostThreadId as string, entry]),
      );
      const externalRows = new Map(
        externalThreadListEntries({
          records: this.#recordsFor(origin, records),
          query,
          runtimeFor: (threadId) => this.#listRuntimeState(threadId),
          placementOf: (threadId) => placementById.get(threadId),
        }).map((entry) => [String(entry.thread.id), entry.thread]),
      );
      const page = await listSectionThreads({
        query,
        placements,
        externalRows: new Map([
          ...externalRows,
          ...sharedThreads.map((thread) => [String(thread.id), thread] as const),
        ]),
        requestOfficial: (method, params) => this.#requestOfficial(method, params),
      });
      if (!page) {
        await this.#forwardOfficialRequest(request, frame);
        return;
      }
      await this.#writer.json(rpcEnvelope(request, { result: page }));
    } catch (error) {
      if (error instanceof OfficialThreadListError) {
        await this.#writer.json(rpcEnvelope(request, { error: error.rpcError }));
        return;
      }
      await this.#writer.json(rpcError(request, -32082, "Thread list aggregation failed"));
      this.#diagnose(error);
    }
  }

  async #moveThreadSection(
    request: JsonRpcRequest,
    frame: Buffer<ArrayBufferLike>,
    move: DecodedThreadSectionMoveRequest,
  ): Promise<void> {
    try {
      const location = await this.#locateExternalThread(move.threadId);
      if (await this.#writeResolutionError(request, location)) return;
      const [records, placements] = await Promise.all([
        this.#repository.list(),
        this.#repository.listSectionPlacements(),
      ]);
      const outcome = await moveThreadSection({
        move,
        movingExternal: location.kind === "external",
        externalThreadIds: new Set(records.map((record) => record.hostThreadId)),
        placements,
        requestOfficial: (method, params) => this.#requestOfficial(method, params),
        savePlacements: (next) => this.#repository.replaceSectionPlacements(next),
        now: new Date(),
      });
      if (outcome.kind === "moved" && outcome.persistError !== undefined)
        this.#diagnose(outcome.persistError);
      if (outcome.kind === "forward") await this.#forwardOfficialRequest(request, frame);
      else if (outcome.kind === "error")
        await this.#writer.json(rpcEnvelope(request, { error: outcome.error }));
      else await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } catch (error) {
      await this.#writer.json(rpcError(request, -32081, "Thread section could not be moved"));
      this.#diagnose(error);
    }
  }

  async #externalSectionFields(threadId: string) {
    const placements = await this.#repository.listSectionPlacements();
    return threadSectionFields(placements.find((entry) => entry.hostThreadId === threadId));
  }

  /** Cached External Thread projections predate section moves; responses read the placement. */
  async #withExternalSection(thread: JsonObject): Promise<JsonObject> {
    return typeof thread.id === "string"
      ? { ...thread, ...(await this.#externalSectionFields(thread.id)) }
      : thread;
  }

  async #setExternalThreadArchived(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    archived: boolean,
  ): Promise<void> {
    const updated = await this.#persistExternalThreadRecord(
      request,
      location,
      (hostThreadId) => this.#repository.setArchived(hostThreadId, archived),
      "External Thread archive state could not be persisted",
    );
    if (!updated) return;
    await this.#writer.json(
      rpcEnvelope(request, { result: archived ? {} : { thread: updated.thread } }),
    );
    await this.#writer.json({
      method: archived ? "thread/archived" : "thread/unarchived",
      params: { threadId: updated.record.hostThreadId },
    });
  }

  async #updateExternalThreadMetadata(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    update: DecodedThreadMetadataUpdateRequest,
  ): Promise<void> {
    if (update.unsupportedFields.length > 0) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          `External Thread metadata fields are unsupported: ${update.unsupportedFields.join(", ")}`,
        ),
      );
      return;
    }
    if (typeof update.projectId === "string") {
      // Projects belong to official Codex; only assign one it can still read.
      const exists = await this.#requestOfficial("project/read", {
        projectId: update.projectId,
      }).then(
        (response) =>
          !isRecord(response.error) &&
          isRecord(response.result) &&
          isRecord(response.result.project) &&
          response.result.project.id === update.projectId,
        () => false,
      );
      if (!exists) {
        await this.#writer.json(rpcError(request, -32602, "Project is unavailable"));
        return;
      }
    }
    const patch = {
      ...(update.projectId !== undefined ? { projectId: update.projectId } : {}),
      ...(update.daybreakEnabled !== undefined ? { daybreakEnabled: update.daybreakEnabled } : {}),
      ...(update.gitInfo !== undefined ? { gitInfo: update.gitInfo } : {}),
    };
    const previousProjectId = location.record.projectId ?? null;
    const updated = await this.#persistExternalThreadRecord(
      request,
      location,
      (hostThreadId) => this.#repository.updateMetadata(hostThreadId, patch),
      "External Thread metadata could not be persisted",
      true,
    );
    if (!updated) return;
    await this.#writer.json(rpcEnvelope(request, { result: { thread: updated.thread } }));
    const projectId = updated.record.projectId ?? null;
    if (projectId !== previousProjectId) {
      await this.#writer.json({
        method: "thread/project/updated",
        params: { threadId: updated.record.hostThreadId, projectId },
      });
    }
  }

  /** Clear External assignments to a project official Codex reported as deleted. */
  async #clearDeletedProjectAssignments(projectId: string): Promise<void> {
    const records = await this.#repository.list();
    for (const record of records) {
      if (record.projectId !== projectId) continue;
      // A concurrent Desktop update may have reassigned the Thread since the listing.
      const updated = await this.#repository.updateMetadata(
        record.hostThreadId,
        { projectId: null },
        { ifProjectId: projectId },
      );
      if (updated.projectId !== undefined) continue;
      const loaded = this.#externalRuntime.get(updated.hostThreadId);
      if (loaded) this.#syncLoadedExternalThread(loaded, updated);
      await this.#writer.json({
        method: "thread/project/updated",
        params: { threadId: updated.hostThreadId, projectId: null },
      });
    }
  }

  #syncLoadedExternalThread(thread: ExternalThread, record: StoredThreadRecordV1): JsonObject {
    const projected = externalThreadValue({
      record,
      turns: [],
      sessionId: thread.sessionId,
      running: thread.running,
    });
    thread.record = record;
    thread.thread = { ...thread.thread, ...projected, turns: thread.thread.turns ?? [] };
    return projected;
  }

  async #persistExternalThreadRecord(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    write: (hostThreadId: StoredThreadRecordV1["hostThreadId"]) => Promise<StoredThreadRecordV1>,
    failureMessage: string,
    allowProvisional = false,
  ): Promise<{ record: StoredThreadRecordV1; thread: JsonObject } | null> {
    const hasNativeSession =
      location.record.state === "ready" && location.record.nativeSessionRef !== undefined;
    // Host metadata may precede a Harness's deferred native Session, but only
    // while the loaded Thread still owns the provisional record.
    if (!hasNativeSession && !(allowProvisional && location.thread)) {
      await this.#writer.json(rpcError(request, -32079, "External Native Session is unavailable"));
      return null;
    }
    const sessionId =
      location.thread?.sessionId ??
      (await this.#repository.sessionTreeId(location.record).catch(() => null));
    if (!sessionId) {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be projected"),
      );
      return null;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await write(location.record.hostThreadId);
    } catch {
      await this.#writer.json(rpcError(request, -32081, failureMessage));
      return null;
    }
    const projected = location.thread
      ? this.#syncLoadedExternalThread(location.thread, record)
      : externalThreadValue({ record, turns: [], sessionId, loaded: false });
    return { record, thread: await this.#withExternalSection(projected) };
  }

  async #handleConsoleOpen(request: JsonRpcRequest): Promise<void> {
    if (!consoleOpenParamsSchema.safeParse(request.params ?? {}).success) {
      await this.#writer.json(rpcError(request, -32602, "Console params must be empty"));
      return;
    }
    const opener = this.#options.consoleOpener;
    if (!opener) {
      await this.#writer.json(
        rpcError(request, -32090, "The codexhost console is available on the local Host only"),
      );
      return;
    }
    try {
      const result = consoleOpenResultSchema.parse(await opener.open());
      await this.#writer.json(rpcEnvelope(request, { result }));
    } catch (error) {
      await this.#writer.json(rpcError(request, -32092, errorMessage(error).slice(0, 500)));
    }
  }

  async #handleUpdateRequest(request: JsonRpcRequest): Promise<void> {
    const params = updateEmptyParamsSchema.safeParse(
      request.params === undefined ? {} : request.params,
    );
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Update params must be empty"));
      return;
    }
    const coordinator = this.#options.updateCoordinator;
    if (!coordinator) {
      await this.#writer.json(
        request.method === "codexhost/update/check"
          ? rpcEnvelope(request, { result: null })
          : rpcError(request, -32090, "Application updates are unavailable"),
      );
      return;
    }
    try {
      if (request.method === "codexhost/update/check") {
        const result = updateCheckResultSchema.parse(await coordinator.check());
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        return;
      }
      if (request.method === "codexhost/update/status") {
        const result = updateStatusResultSchema.parse(await coordinator.status());
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        return;
      }
      const result = updateStartResultSchema.parse(await coordinator.start());
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    } catch (error) {
      await this.#writer.json(rpcError(request, -32091, errorMessage(error).slice(0, 500)));
    }
  }

  async #inspectHarness(request: JsonRpcRequest): Promise<void> {
    const params = harnessInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Harness inspection params"));
      return;
    }
    await this.#waitForPlugins();
    const registered = [...this.#externalAdapters].find(
      ([harnessId]) => harnessId === params.data.harnessId,
    );
    const adapter = registered?.[1];
    if (!adapter) {
      await this.#writer.json(
        rpcError(request, -32077, `Harness '${params.data.harnessId}' is unavailable`),
      );
      return;
    }
    let inspection: unknown;
    try {
      inspection = await adapter.inspect({
        ...(params.data.cwd ? { cwd: params.data.cwd } : {}),
        ...(params.data.refresh !== undefined ? { refresh: params.data.refresh } : {}),
        ...(params.data.purpose ? { purpose: params.data.purpose } : {}),
      });
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32077, `Harness inspection failed: ${errorMessage(error)}`),
      );
      return;
    }
    const validated = harnessInspectionSchema.safeParse(inspection);
    if (!validated.success) {
      await this.#writer.json(
        rpcError(request, -32077, "Harness inspection returned an invalid result"),
      );
      return;
    }
    await this.#writer.json(
      rpcEnvelope(request, { result: jsonValueSchema.parse(validated.data) }),
    );
  }

  async #openHarnessWebUi(request: JsonRpcRequest): Promise<void> {
    const params = harnessWebUiOpenParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Harness Web UI params"));
      return;
    }
    await this.#waitForPlugins();
    const adapter = [...this.#externalAdapters].find(
      ([harnessId]) => harnessId === params.data.harnessId,
    )?.[1];
    const webUi = adapter?.webUi;
    if (!webUi) {
      await this.#writer.json(rpcError(request, -32092, "Harness Web UI is unavailable"));
      return;
    }
    try {
      const result = await webUi.open();
      if (!result.ok) {
        await this.#writer.json(rpcError(request, -32092, "Harness Web UI could not be opened"));
        return;
      }
      await this.#writer.json(
        rpcEnvelope(request, { result: harnessWebUiOpenResultSchema.parse({}) }),
      );
    } catch {
      await this.#writer.json(rpcError(request, -32092, "Harness Web UI could not be opened"));
    }
  }

  async #handleSessionImport(request: JsonRpcRequest): Promise<void> {
    await this.#waitForPlugins();
    this.#sessionImportRequests ??= new SessionImportRequests({
      adapters: this.#externalAdapters,
      descriptors: () => this.#pluginDescriptors,
      repository: this.#repository,
      diagnose: (error) => this.#diagnose(error),
    });
    const response = await this.#sessionImportRequests.handle(request);
    await this.#writer.json(rpcEnvelope(request, response.body));
    if (response.importedThread) await this.#notifyExternalThreadStarted(response.importedThread);
  }

  async #inspectThread(request: JsonRpcRequest): Promise<void> {
    const params = threadInspectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread inspection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const supportsThreadReferences =
      resolution.kind === "official" &&
      params.data.includeReferenceCapability === true &&
      (await nativeThreadSupportsReferences({
        codexHome: this.#officialRuntimeScope.permanentHome,
        threadId: params.data.threadId,
        readThread: () =>
          this.#officialRuntime.request("thread/read", {
            threadId: params.data.threadId,
            includeTurns: false,
          }),
      }));
    const threadUsage =
      resolution.kind === "official" ? null : await this.#threadUsage(resolution.thread);
    const inspection = threadInspectionSchema.parse(
      resolution.kind === "official"
        ? {
            owner: "codex",
            locked: true,
            ...(supportsThreadReferences ? { supportsThreadReferences: true } : {}),
          }
        : {
            owner: "external",
            harnessId: resolution.thread.harnessId,
            transportModelId: resolution.thread.transportModelId,
            ...(resolution.thread.stateObserver.state.effectiveModel
              ? { effectiveModel: resolution.thread.stateObserver.state.effectiveModel }
              : {}),
            ...(resolution.thread.stateObserver.state.resolvedModelLabel
              ? { resolvedModelLabel: resolution.thread.stateObserver.state.resolvedModelLabel }
              : {}),
            ...(resolution.thread.stateObserver.state.effectiveThinkingOptionId
              ? {
                  effectiveThinkingOptionId:
                    resolution.thread.stateObserver.state.effectiveThinkingOptionId,
                }
              : {}),
            ...(resolution.thread.stateObserver.state.availableThinkingOptions
              ? {
                  availableThinkingOptions:
                    resolution.thread.stateObserver.state.availableThinkingOptions,
                }
              : {}),
            ...(resolution.thread.stateObserver.state.effectivePermissionModeId
              ? {
                  effectivePermissionModeId:
                    resolution.thread.stateObserver.state.effectivePermissionModeId,
                }
              : {}),
            history: resolution.thread.session.capabilities.history,
            ...(threadUsage ? { usage: threadUsage } : {}),
            locked: true,
          },
    );
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(inspection) }));
  }

  async #inspectThreadUsage(request: JsonRpcRequest): Promise<void> {
    const params = threadUsageInspectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread Usage inspection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    if (resolution.kind === "official") {
      if (params.data.refresh !== undefined) {
        await this.#writer.json(
          rpcError(request, -32602, "Exact Usage refresh is only available for External Threads"),
        );
        return;
      }
      await this.#waitForPlugins();
      const accountId = await this.#currentCodexAccountId();
      if (accountId) await this.#refreshOfficialRateLimits(accountId);
      const accountCredits = this.#officialAccountCredits(accountId ?? undefined);
      const result = threadUsageInspectionSchema.parse({
        threadId: params.data.threadId,
        usage: await this.#observedSessionUsage.read(params.data.threadId),
        accountCreditsSupported: true,
        ...(accountCredits ? { accountCredits } : {}),
      });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      return;
    }
    if (params.data.refresh === "exact") void resolution.thread.session.refreshUsage?.();
    const adapter = this.#externalAdapters.get(resolution.thread.harnessId);
    if (adapter?.credits && adapter.refreshCredits)
      void Promise.resolve()
        .then(() => adapter.refreshCredits?.())
        .catch(() => undefined);
    let credits: AccountCreditsSnapshot | null = null;
    try {
      credits = parseHarnessAccountCredits(adapter?.credits?.());
    } catch {
      // Optional account telemetry cannot fail the Thread's usage inspection.
    }
    const result = threadUsageInspectionSchema.parse({
      threadId: params.data.threadId,
      usage: await this.#threadUsage(resolution.thread),
      accountCreditsSupported: typeof adapter?.credits === "function",
      ...(credits ? { accountCredits: credits } : {}),
    });
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
  }

  #refreshOfficialRateLimits(accountId: string, force = false) {
    return this.#officialRateLimits.refresh(
      accountId,
      async () => this.#officialRuntime.request("account/rateLimits/read", {}),
      force,
    );
  }

  #officialAccountCredits(accountId: string | undefined): AccountCreditsSnapshot | null {
    if (!accountId) return null;
    return projectCodexRateLimitsToCredits(
      this.#officialRateLimits.get(accountId),
      this.#officialRateLimits.getResetCredits(accountId),
    );
  }

  async #listThreadOwnership(request: JsonRpcRequest): Promise<void> {
    const params = threadOwnershipListParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread ownership-list params"));
      return;
    }
    try {
      const shared = await this.#options.sharedThreads?.ownership(params.data.threadIds);
      const threads = await Promise.all(
        params.data.threadIds.map(async (threadId) => {
          const sharedHarness = shared?.get(threadId);
          if (sharedHarness)
            return { threadId, owner: "external" as const, harnessId: sharedHarness };
          const record = await this.#repository.find(threadId);
          return record
            ? { threadId, owner: "external" as const, harnessId: record.harnessId }
            : { threadId, owner: "codex" as const };
        }),
      );
      const result = threadOwnershipListResultSchema.parse({ threads });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "Thread ownership metadata could not be read"),
      );
    }
  }

  /** Read the same delivery decision that Desktop `turn/steer` will follow. */
  async #inspectThreadSteering(request: JsonRpcRequest): Promise<void> {
    const params = threadSteeringInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread steering params"));
      return;
    }
    let delivery: "official" | "activeTurn" | "newTurn";
    try {
      const location = await this.#locateExternalThread(params.data.threadId);
      if (await this.#writeResolutionError(request, location)) return;
      const thread =
        location.kind === "external" ? this.#externalRuntime.get(params.data.threadId) : undefined;
      delivery =
        location.kind !== "external"
          ? "official"
          : thread
            ? await externalSteeringDelivery(thread, params.data.text)
            : "newTurn";
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "Thread steering metadata could not be read"),
      );
      return;
    }
    const result = threadSteeringInspectResultSchema.parse({ delivery });
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
  }

  async #inspectThreadCommands(request: JsonRpcRequest): Promise<void> {
    const params = threadCommandsInspectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread command inspection params"),
      );
      return;
    }
    const location = await this.#locateExternalThread(params.data.threadId);
    if (await this.#writeResolutionError(request, location)) return;
    if (location.kind !== "external") {
      await this.#writer.json(rpcEnvelope(request, { result: { commands: [] } }));
      return;
    }
    // A loaded Session reports its live catalog (custom commands, skills). Never
    // open a Session only to read commands; unloaded Threads fall back to the
    // workspace cache, then the static catalog.
    const loaded = this.#externalRuntime.get(params.data.threadId);
    if (loaded) {
      const catalog = await this.#inspectLoadedCommands(loaded);
      if (catalog) {
        await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(catalog) }));
        return;
      }
    }
    await this.#writeHarnessCommandCatalog(
      request,
      location.record.harnessId,
      loaded?.cwd ?? location.record.cwd,
      params.data.threadId,
    );
  }

  /**
   * Catalog of a loaded Session, marked live or static. A live catalog is
   * remembered for its Harness and workspace so later drafts there can show it.
   */
  async #inspectLoadedCommands(thread: ExternalThread): Promise<HarnessCommandCatalog | null> {
    if (!thread.session.commands) return null;
    const catalog = await inspectLiveCommandCatalog(thread.session.commands);
    if (!catalog) return null;
    const staticCatalog = this.#externalAdapters.get(thread.harnessId)?.commandCatalog;
    if (staticCatalog && !isLiveCommandCatalog(catalog, staticCatalog)) return null;
    const live = { ...catalog, source: "live" as const };
    this.#liveCommandCache.remember(thread.harnessId, thread.cwd, live);
    return live;
  }

  async #writeHarnessCommandCatalog(
    request: JsonRpcRequest,
    harnessId: HarnessId,
    cwd?: string,
    inspectedThreadId?: string,
  ): Promise<void> {
    await this.#waitForPlugins();
    const adapter = this.#externalAdapters.get(harnessId);
    if (!adapter) {
      await this.#writer.json(rpcError(request, -32077, `Harness '${harnessId}' is unavailable`));
      return;
    }
    let catalog: HarnessCommandCatalog;
    try {
      // `static` tells the Composer live commands exist but are not loaded
      // yet; Harnesses without live catalogs leave the source unset.
      catalog = harnessCommandCatalogSchema.parse({
        ...(adapter.commandCatalog ?? { commands: [] }),
        ...(adapter.liveCommandCatalog ? { source: "static" } : {}),
      });
    } catch {
      await this.#writer.json(rpcError(request, -32078, "Harness command catalog is invalid"));
      return;
    }
    if (cwd && adapter.liveCommandCatalog) {
      // Draft of a known workspace: a loaded Session there (a prewarmed draft
      // or an open Thread) or the last catalog seen for it. Never start one.
      for (const thread of this.#externalRuntime.values()) {
        if (thread.id === inspectedThreadId) continue;
        if (thread.harnessId !== harnessId || !sameWorkspace(thread.cwd, cwd)) continue;
        const live = await this.#inspectLoadedCommands(thread);
        if (live) {
          catalog = live;
          break;
        }
      }
      if (catalog.source === "static") {
        catalog = this.#liveCommandCache.lookup(harnessId, cwd) ?? catalog;
      }
    }
    await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(catalog) }));
  }

  async #executeThreadCommand(request: JsonRpcRequest): Promise<void> {
    const params = threadCommandExecuteParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread command parameters"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (await this.#writeResolutionError(request, resolution)) return;
    if (resolution.kind !== "external") {
      await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
      return;
    }
    this.#dispatchDesktopReply(
      request,
      () => this.#executeResolvedThreadCommand(request, resolution.thread, params.data),
      resolution.thread.id,
    );
  }

  async #executeResolvedThreadCommand(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: ReturnType<typeof threadCommandExecuteParamsSchema.parse>,
  ): Promise<void> {
    if (this.#externalThreadBusy(thread) || this.#pendingExternalCommandRequests.has(thread.id)) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active operation"),
      );
      return;
    }
    this.#pendingExternalCommandRequests.add(thread.id);
    try {
      const commands = thread.session.commands;
      if (!commands) {
        await this.#writer.json(
          rpcError(request, -32078, "External Harness does not expose commands"),
        );
        return;
      }
      const catalog = await commands.list();
      if (!catalog.ok) {
        await this.#writer.json(rpcError(request, -32078, catalog.error.message));
        return;
      }
      const descriptor = catalog.value.commands.find(({ id }) => id === params.commandId);
      if (!descriptor) {
        await this.#writer.json(
          rpcError(
            request,
            -32078,
            `External Harness does not expose command '${params.commandId}'`,
          ),
        );
        return;
      }
      try {
        const started = await this.#beginExternalCommand(
          thread,
          descriptor,
          params.arguments,
          params.turnId,
        );
        try {
          const result = threadCommandExecuteResultSchema.parse({
            accepted: true,
            turnId: started.turnId,
          });
          await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
        } finally {
          started.gate.resolve();
        }
      } catch (error) {
        this.#diagnose(error);
        await this.#writer.json(
          error instanceof ExternalCommandError
            ? rpcError(request, error.code, error.message)
            : rpcError(request, -32073, `External Harness command failed: ${errorMessage(error)}`),
        );
      }
    } finally {
      this.#pendingExternalCommandRequests.delete(thread.id);
    }
  }

  async #beginExternalCommand(
    thread: ExternalThread,
    descriptor: HarnessCommandDescriptor,
    arguments_: JsonObject | undefined,
    requestedTurnId?: HostTurnId,
    sourceHostId?: unknown,
  ): Promise<{ turnId: HostTurnId; turn: JsonObject; gate: TurnProjectionGate }> {
    const commands = thread.session.commands;
    if (!commands) {
      throw new ExternalCommandError(-32078, "External Harness does not expose commands");
    }
    if (this.#closeRequested || this.#externalRuntime.get(thread.id) !== thread) {
      throw new ExternalCommandError(-32073, "External Thread is no longer available");
    }
    // Admission belongs to the caller. A steering replacement retains its
    // reservation until this command starts, after the old Turn has stopped.
    if (thread.running || thread.activeTurnId) {
      throw new ExternalCommandError(-32072, "External Thread already has an active operation");
    }
    const turnId = requestedTurnId ?? hostTurnIdSchema.parse(randomUUID());
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs: Date.now(),
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTerminalTurnId = null;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);
    thread.ephemeralTurnIds.add(turnId);
    if (descriptor.invocation === "/compact") this.#manualCompactionTurns.set(thread, turnId);
    else this.#manualCompactionTurns.delete(thread);

    const restoreExecutionHost = this.#setExecutionHost(thread, sourceHostId);
    try {
      if (thread.unsubmittedPrewarm && (await this.#externalRuntime.submitPrewarm(thread))) {
        await this.#notifyExternalThreadStarted(thread.thread);
      }
      const result = await commands.execute({
        turnId,
        commandId: descriptor.id,
        ...(arguments_ ? { arguments: arguments_ } : {}),
      });
      if (!result.ok) throw new ExternalCommandError(-32073, result.error.message);
      thread.clientCommand = {
        name: descriptor.invocation.slice(1),
        turn: projection.projector.snapshotTurn(),
      };
      return { turnId: result.value.turnId, turn: projection.projector.pendingTurn(), gate };
    } catch (error) {
      restoreExecutionHost();
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      thread.ephemeralTurnIds.delete(turnId);
      this.#manualCompactionTurns.delete(thread);
      gate.resolve();
      this.#signalActiveWorkChanged();
      throw error;
    }
  }

  async #selectThreadModel(request: JsonRpcRequest): Promise<void> {
    const params = threadModelSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Thread Model selection params"));
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(request, -32078, "Model selection requires a current-process external Thread"),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectModel) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Model selection"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "model.select",
      model: params.data.model,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessModelSelectionStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectiveModel) {
        throw new Error("Harness Session did not report an effective Model");
      }
      // Resume and Fork read the saved selection, so keep it on the confirmed Model.
      const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
        ...(decodeExternalTransportSelection(thread.harnessId, thread.transportModelId) ?? {}),
        model: projected.effectiveModel,
      });
      thread.transportModelId = transportModelId;
      thread.requestedModel = projected.effectiveModel;
      try {
        thread.record = await this.#repository.setTransportModelId(
          thread.record.hostThreadId,
          transportModelId,
        );
      } catch (error) {
        this.#diagnose(error);
      }
      thread.thread = externalThreadValue({
        record: { ...thread.record, transportModelId },
        turns: thread.turns,
        sessionId: thread.sessionId,
        running: thread.running,
      });
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Model state was not confirmed: ${errorMessage(error)}`),
      );
    }
  }

  async #selectThreadThinking(request: JsonRpcRequest): Promise<void> {
    const params = threadThinkingSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread Thinking selection params"),
      );
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(request, -32078, "Thinking selection requires a current-process external Thread"),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectThinkingOption) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Thinking selection"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "thinking.select",
      thinkingOptionId: params.data.thinkingOptionId,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessModelSelectionStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectiveThinkingOptionId) {
        throw new Error("Harness Session did not report effective Thinking");
      }
      thread.requestedThinkingOptionId = projected.effectiveThinkingOptionId;
      const previousSelection = decodeExternalTransportSelection(
        thread.harnessId,
        thread.transportModelId,
      );
      const effectiveModel =
        projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
      if (effectiveModel) {
        const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
          ...(previousSelection ?? {}),
          model: effectiveModel,
          thinkingOptionId: projected.effectiveThinkingOptionId,
        });
        thread.transportModelId = transportModelId;
        thread.requestedModel = effectiveModel;
        try {
          thread.record = await this.#repository.setTransportModelId(
            thread.record.hostThreadId,
            transportModelId,
          );
        } catch (error) {
          this.#diagnose(error);
        }
        thread.thread = externalThreadValue({
          record: { ...thread.record, transportModelId },
          turns: thread.turns,
          sessionId: thread.sessionId,
          running: thread.running,
        });
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32078, `Thinking state was not confirmed: ${errorMessage(error)}`),
      );
    }
  }

  async #selectThreadPermissionMode(request: JsonRpcRequest): Promise<void> {
    const params = threadPermissionModeSelectParamsSchema.safeParse(request.params);
    if (!params.success) {
      await this.#writer.json(
        rpcError(request, -32602, "Invalid Thread Permission Mode selection params"),
      );
      return;
    }
    const resolution = await this.#resolveExternalThread(params.data.threadId);
    if (resolution.kind === "error") {
      await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
      return;
    }
    const thread = resolution.kind === "external" ? resolution.thread : undefined;
    if (!thread) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          "Permission Mode selection requires a current-process external Thread",
        ),
      );
      return;
    }
    if (!thread.session.capabilities.configuration.selectPermissionMode) {
      await this.#writer.json(
        rpcError(request, -32078, "External Harness does not support Permission Mode selection"),
      );
      return;
    }
    if (permissionModeFixedAtCreate(thread.session.capabilities.configuration)) {
      await this.#writer.json(
        rpcError(request, -32078, "Permission Mode is fixed at Session creation"),
      );
      return;
    }
    const beforeRevision = thread.stateObserver.revision;
    const result = await thread.session.execute({
      type: "permissionMode.select",
      permissionModeId: params.data.permissionModeId,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32078, result.error.message));
      return;
    }
    try {
      const state = await thread.stateObserver.waitForChange(beforeRevision);
      const projected = harnessConfigurationStateSchema.parse({
        ...(state.effectiveModel ? { effectiveModel: state.effectiveModel } : {}),
        ...(state.resolvedModelLabel ? { resolvedModelLabel: state.resolvedModelLabel } : {}),
        ...(state.effectiveThinkingOptionId
          ? { effectiveThinkingOptionId: state.effectiveThinkingOptionId }
          : {}),
        ...(state.availableThinkingOptions
          ? { availableThinkingOptions: state.availableThinkingOptions }
          : {}),
        ...(state.effectivePermissionModeId
          ? { effectivePermissionModeId: state.effectivePermissionModeId }
          : {}),
      });
      if (!projected.effectivePermissionModeId) {
        throw new Error("Harness Session did not report its current Permission Mode");
      }
      thread.requestedPermissionModeId = projected.effectivePermissionModeId;
      const previousSelection = decodeExternalTransportSelection(
        thread.harnessId,
        thread.transportModelId,
      );
      const effectiveModel =
        projected.effectiveModel ?? thread.requestedModel ?? previousSelection?.model;
      if (effectiveModel) {
        const transportModelId = encodeExternalTransportSelection(thread.harnessId, {
          ...(previousSelection ?? {}),
          model: effectiveModel,
          permissionModeId: projected.effectivePermissionModeId,
        });
        thread.transportModelId = transportModelId;
        thread.requestedModel = effectiveModel;
        thread.thread = externalThreadValue({
          record: { ...thread.record, transportModelId },
          turns: thread.turns,
          sessionId: thread.sessionId,
          running: thread.running,
        });
        // Resume restores the saved selection, so an unsaved change must not
        // be reported as a completed selection.
        try {
          thread.record = await this.#repository.setTransportModelId(
            thread.record.hostThreadId,
            transportModelId,
          );
        } catch (error) {
          this.#diagnose(error);
          await this.#writer.json(
            rpcError(
              request,
              -32078,
              `Permission Mode was applied but could not be saved: ${errorMessage(error)}`,
            ),
          );
          return;
        }
      }
      await this.#writer.json(rpcEnvelope(request, { result: jsonValueSchema.parse(projected) }));
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          -32078,
          `Permission Mode state was not confirmed: ${errorMessage(error)}`,
        ),
      );
    }
  }

  async #startExternalThread(
    request: JsonRpcRequest,
    harnessId: ExternalHarnessId,
    origin: HostRequestOrigin,
  ): Promise<void> {
    await this.#waitForPlugins();
    if (!this.#eligibleFor(origin, "desktop", harnessId)) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32070, `Harness '${harnessId}' is not available in Desktop`),
      );
      return;
    }
    const adapter = this.#externalAdapters.get(harnessId);
    if (!adapter) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32070, `External Harness '${harnessId}' is unavailable`),
      );
      return;
    }
    const params = requestObject(request);
    const route = decodeCreateRoute(request);
    // Renderer-side prewarms mark the request; main-process prewarms can mark only the Model.
    const prewarm = params[EXTERNAL_THREAD_PREWARM_PARAM] === true || route?.prewarm === true;
    const requestedModel = route && route.harnessId !== "codex" ? route.model : undefined;
    const requestedThinkingOptionId =
      route && route.harnessId !== "codex" ? route.thinkingOptionId : undefined;
    const requestedPermissionModeId =
      route && route.harnessId !== "codex" ? route.permissionModeId : undefined;
    const transportModelId =
      route && route.harnessId === harnessId
        ? route.transportModelId
        : transportModelIdForHarness(harnessId);
    let cwd = params.cwd;
    let projectlessWorkspace: StoredThreadRecordV1["projectlessWorkspace"];
    if (params.projectlessWorkspace !== undefined) {
      const choice = clientProjectlessWorkspaceSchema.safeParse(params.projectlessWorkspace);
      if (!choice.success || cwd !== undefined || params.ephemeral === true) {
        this.#routeObservationTracker.rejectCreate(request.id);
        await this.#writer.json(rpcError(request, -32602, "Invalid projectless workspace choice"));
        return;
      }
      try {
        const allocated = await allocateProjectlessWorkspace(
          this.#options.environment ?? process.env,
          choice.data.prompt ?? "",
        );
        cwd = allocated.cwd;
        projectlessWorkspace = {
          workspaceRoot: allocated.workspaceRoot,
          outputDirectory: allocated.outputDirectory,
        };
      } catch (error) {
        this.#routeObservationTracker.rejectCreate(request.id);
        await this.#writer.json(
          rpcError(
            request,
            -32081,
            `Projectless workspace could not be allocated: ${errorMessage(error)}`,
          ),
        );
        return;
      }
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(
        rpcError(request, -32602, `External Harness '${harnessId}' thread/start requires cwd`),
      );
      return;
    }

    const recordInput = createExternalThreadRecordInput({
      harnessId: adapter.harnessId,
      cwd,
      transportModelId,
      ...(projectlessWorkspace ? { projectlessWorkspace } : {}),
      ephemeral: params.ephemeral === true,
      historyMode: params.historyMode === "paginated" ? "paginated" : "legacy",
    });
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.createProvisional(recordInput);
    } catch {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#writer.json(rpcError(request, -32081, "External Thread could not be persisted"));
      return;
    }

    const sessionResult = await adapter.open({
      kind: "create",
      cwd,
      environment: {
        ...(this.#options.environment ?? process.env),
        [DELEGATION_THREAD_ID_ENV]: record.hostThreadId,
      },
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedThinkingOptionId ? { thinkingOptionId: requestedThinkingOptionId } : {}),
      ...(requestedPermissionModeId ? { permissionModeId: requestedPermissionModeId } : {}),
    });
    if (!sessionResult.ok) {
      this.#routeObservationTracker.rejectCreate(request.id);
      await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
      const mapped = mapExternalThreadHarnessError(sessionResult.error, "create");
      await this.#writer.json(rpcError(request, mapped.code, mapped.message));
      return;
    }
    const session = sessionResult.value;
    await this.#externalRuntime.idleRelease.runOperation(record.hostThreadId, async () => {
      try {
        if (session.initialState.nativeRef && !prewarm) {
          record = await this.#repository.commitNative(
            record.hostThreadId,
            session.initialState.nativeRef,
          );
        }
        const thread = externalThreadValue({
          record,
          turns: [],
          sessionId: record.hostThreadId,
        });
        const externalThread = this.#registerExternalThread({
          record,
          session,
          unsubmittedPrewarm: prewarm,
          sessionId: record.hostThreadId,
          thread,
          turns: [],
          ...(requestedModel ? { requestedModel } : {}),
          ...(requestedThinkingOptionId ? { requestedThinkingOptionId } : {}),
          ...(requestedPermissionModeId ? { requestedPermissionModeId } : {}),
        });
        if (prewarm) {
          this.#externalPrewarms.register(externalThread);
        }
        this.#routeObservationTracker.bindCreatedThread(request.id, externalThread.id);
        await this.#writer.json(
          rpcEnvelope(request, {
            result: {
              thread,
              model: transportModelId,
              modelProvider: "codexhost",
              cwd,
              approvalPolicy:
                typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
              approvalsReviewer: "user",
              sandbox: sandboxResult(params),
              reasoningEffort: "medium",
              serviceTier: "flex",
              multiAgentMode: "explicitRequestOnly",
              activePermissionProfile: null,
              runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
                ? params.runtimeWorkspaceRoots
                : [],
              instructionSources: [],
            },
          }),
        );
        // Draft prewarms remain provisional even when the Harness already has
        // an identity. Only user submission may publish them to Desktop history.
        if (record.state === "ready") await this.#notifyExternalThreadStarted(thread);
      } catch {
        this.#externalRuntime.remove(record.hostThreadId);
        this.#routeObservationTracker.forgetThread(record.hostThreadId);
        await session.close().catch(() => undefined);
        await this.#repository.removeProvisional(record.hostThreadId).catch(() => undefined);
        await this.#writer.json(
          rpcError(request, -32081, "External Thread could not be persisted"),
        );
      }
    });
  }

  #registerExternalThread(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    requestedPermissionModeId?: HarnessPermissionModeId;
    unsubmittedPrewarm?: boolean;
  }): ExternalThread {
    return this.#externalRuntime.register(input);
  }

  async #locateExternalThread(threadId: string): Promise<ExternalThreadLocation> {
    const location = await this.#externalRuntime.locate(threadId);
    if (location.kind === "external") this.#client.noteExternalThread(threadId);
    return location;
  }

  async #resolveExternalThread(threadId: string): Promise<ExternalThreadResolution> {
    const location = await this.#locateExternalThread(threadId);
    if (location.kind !== "external") return location;
    await this.#waitForPlugins();
    return this.#externalRuntime.resolve(threadId);
  }

  async #writeResolutionError(
    request: JsonRpcRequest,
    resolution: ExternalThreadLocation | ExternalThreadResolution,
  ): Promise<boolean> {
    if (resolution.kind !== "error") return false;
    await this.#writer.json(rpcError(request, resolution.error.code, resolution.error.message));
    return true;
  }

  /** Refresh history before Desktop acts on native Turn boundaries. */
  #refreshExternalThread(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    return this.#externalRuntime.refresh(thread);
  }

  #markExternalHistoryRead(thread: ExternalThread, turns: JsonObject[]): void {
    if (!thread.historyHydrated) return;
    for (const turnId of thread.steeredTurnIds) {
      if (
        turnId !== thread.activeTurnId &&
        turns.some(
          (turn) =>
            turn.id === turnId &&
            (turn.status === "completed" ||
              turn.status === "failed" ||
              turn.status === "interrupted"),
        )
      ) {
        thread.steeredTurnIds.delete(turnId);
      }
    }
  }

  async #forkExternalThreadFromRenderer(request: JsonRpcRequest): Promise<void> {
    const parsed = externalThreadForkParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      await this.#writer.json(rpcError(request, -32602, "External Fork request is invalid"));
      return;
    }
    const resolution = await this.#resolveExternalThread(parsed.data.threadId);
    if (await this.#writeResolutionError(request, resolution)) return;
    if (resolution.kind !== "external") {
      await this.#writer.json(rpcError(request, -32078, "Thread is not externally owned"));
      return;
    }
    const result = await executeExternalThreadFork({
      source: resolution.thread,
      fork: {
        threadId: parsed.data.threadId,
        lastTurnId: parsed.data.lastTurnId,
        excludeTurns: true,
      },
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(
      rpcEnvelope(request, {
        result: externalThreadForkResultSchema.parse({ threadId: result.derived.id }),
      }),
    );
    await this.#notifyExternalThreadStarted(result.thread);
  }

  async #forkExternalThread(
    request: JsonRpcRequest,
    source: ExternalThread,
    fork: DecodedThreadForkRequest,
  ): Promise<void> {
    const result = await executeExternalThreadFork({
      source,
      fork,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    const params: JsonObject = {
      ...(fork.sandbox ? { sandbox: fork.sandbox } : {}),
    };
    await this.#writer.json(
      rpcEnvelope(request, {
        result: threadForkResult(result.responseThread, {
          model: result.derived.transportModelId,
          cwd: result.derived.cwd,
          ...(fork.runtimeWorkspaceRoots
            ? { runtimeWorkspaceRoots: fork.runtimeWorkspaceRoots }
            : {}),
          ...(fork.approvalPolicy ? { approvalPolicy: fork.approvalPolicy } : {}),
          sandbox: sandboxResult(params),
          ...(fork.serviceTier ? { serviceTier: fork.serviceTier } : {}),
        }),
      }),
    );
    await this.#notifyExternalThreadStarted(result.thread);
  }

  async #notifyExternalThreadStarted(thread: JsonObject): Promise<void> {
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread: { ...thread, turns: [] } },
    });
  }

  async #revertExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    revert: DecodedThreadRevertRequest,
  ): Promise<void> {
    if (thread.record.historyMode !== "paginated") {
      await this.#writer.json(
        rpcError(request, -32602, "External thread/revert requires paginated history"),
      );
      return;
    }
    const result = await executeExternalThreadRollback({
      derived: thread,
      rollback: { threadId: revert.threadId, numTurns: 1 },
      expectedLastTurnId: revert.beforeTurnId,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(rpcEnvelope(request, { result: threadRevertResult(result.thread) }));
    await this.#writer.json({ method: "thread/reverted", params: { threadId: thread.id } });
  }

  async #rollbackExternalThread(
    request: JsonRpcRequest,
    derived: ExternalThread,
    rollback: DecodedThreadRollbackRequest,
  ): Promise<void> {
    const result = await executeExternalThreadRollback({
      derived,
      rollback,
      adapters: this.#externalAdapters,
      repository: this.#repository,
      runtime: this.#externalRuntime,
      environment: this.#options.environment ?? process.env,
    });
    if (!result.ok) {
      await this.#writer.json(rpcError(request, result.error.code, result.error.message));
      return;
    }
    await this.#writer.json(
      rpcEnvelope(request, {
        result: threadRollbackResult(await this.#withExternalSection(result.thread)),
      }),
    );
  }

  async #setExternalThreadName(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
    name: JsonValue | undefined,
  ): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      await this.#writer.json(
        rpcError(request, -32602, "External Thread name must be a non-empty string"),
      );
      return;
    }
    let record: StoredThreadRecordV1;
    try {
      record = await this.#repository.setTitle(location.record.hostThreadId, name);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread title could not be persisted"),
      );
      return;
    }
    if (location.thread) {
      location.thread.record = record;
      location.thread.thread.name = name;
      location.thread.thread.updatedAt = unixSeconds();
    }
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/name/updated",
      params: { threadId: location.record.hostThreadId, threadName: name },
    });
  }

  async #deleteExternalThread(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    try {
      await this.#externalRuntime.deleteThread(location.record.hostThreadId);
    } catch (error) {
      if (!(error instanceof ExternalSessionReleaseError) && location.thread)
        await this.#resolveThreadInteractions(location.thread);
      await this.#writer.json(
        error instanceof ExternalSessionReleaseError
          ? rpcError(request, -32075, error.message)
          : rpcError(request, -32081, "External Thread could not be removed"),
      );
      return;
    }
    if (location.thread) await this.#resolveThreadInteractions(location.thread);
    this.#routeObservationTracker.forgetThread(location.record.hostThreadId);
    this.#externalQueue.clear(location.record.hostThreadId);
    this.#queuedTurnStarts.delete(location.record.hostThreadId);
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/deleted",
      params: { threadId: location.record.hostThreadId },
    });
  }

  async #readExternalThreadMetadata(
    request: JsonRpcRequest,
    location: Extract<ExternalThreadLocation, { kind: "external" }>,
  ): Promise<void> {
    try {
      const thread = {
        ...(location.thread
          ? { ...location.thread.thread, turns: [] }
          : externalThreadValue({
              record: location.record,
              turns: [],
              sessionId: await this.#repository.sessionTreeId(location.record),
            })),
        ...(await this.#externalSectionFields(location.record.hostThreadId)),
      };
      await this.#writer.json(rpcEnvelope(request, { result: { thread } }));
      if (location.thread) await this.#replayExternalUsage(location.thread);
    } catch {
      await this.#writer.json(
        rpcError(request, -32081, "External Thread metadata could not be read"),
      );
    }
  }

  async #readExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    includeTurns: boolean,
    historyFresh: boolean,
  ): Promise<void> {
    if (includeTurns && thread.record.historyMode === "paginated") {
      await this.#writer.json(
        rpcError(request, -32602, "Paginated External Threads require thread/turns/list"),
      );
      return;
    }
    if (includeTurns && !thread.running && !historyFresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    const readTurns = includeTurns ? [...this.#externalHistoryTurns(thread)] : [];
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          thread: {
            ...thread.thread,
            ...(await this.#externalSectionFields(thread.record.hostThreadId)),
            turns: readTurns,
          },
        },
      }),
    );
    if (includeTurns) this.#markExternalHistoryRead(thread, readTurns);
    await this.#replayExternalUsage(thread);
  }

  async #listExternalHistory(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    const headPage = params.cursor === null || params.cursor === undefined;
    const requiresRefresh =
      request.method === "thread/turns/list" ||
      (request.method === "thread/items/list" && !thread.historyHydrated);
    if (!thread.running && !historyFresh && headPage && requiresRefresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    try {
      const turns = this.#externalHistoryTurns(thread);
      const result =
        request.method === "thread/turns/list"
          ? listExternalTurns(turns, params)
          : listExternalItems(turns, params);
      await this.#writer.json(rpcEnvelope(request, { result }));
      if (request.method === "thread/turns/list") {
        this.#markExternalHistoryRead(thread, result.data);
      }
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  async #resumeExternalThread(
    request: JsonRpcRequest,
    thread: ExternalThread,
    params: JsonObject,
    historyFresh: boolean,
  ): Promise<void> {
    if (!thread.running && !historyFresh) {
      const refreshed = await this.#refreshExternalThread(thread);
      if (refreshed) {
        await this.#writer.json(rpcError(request, refreshed.code, refreshed.message));
        return;
      }
    }
    const turns = [...this.#externalHistoryTurns(thread)];
    const responseThread = {
      ...(await this.#withExternalSection(thread.thread)),
      turns: params.excludeTurns === true ? [] : turns,
    };
    const result = threadForkResult(responseThread, {
      model: thread.transportModelId,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
        ? params.runtimeWorkspaceRoots.filter((value): value is string => typeof value === "string")
        : [],
      approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
      sandbox: sandboxResult(params),
      ...(typeof params.serviceTier === "string" ? { serviceTier: params.serviceTier } : {}),
    });
    try {
      if (
        params.initialTurnsPage !== undefined &&
        params.initialTurnsPage !== null &&
        !isRecord(params.initialTurnsPage)
      ) {
        throw new ExternalHistoryRequestError("initialTurnsPage must be an object");
      }
      const initialPageParams = isRecord(params.initialTurnsPage)
        ? (params.initialTurnsPage as JsonObject)
        : null;
      const initialTurnsPage = initialPageParams
        ? listExternalTurns(turns, initialPageParams)
        : null;
      const paginated = thread.record.historyMode === "paginated";
      const turnsBackwardsCursor = paginated
        ? listExternalTurns(turns, { limit: 1, itemsView: "notLoaded" }).backwardsCursor
        : null;
      const itemsBackwardsCursor = paginated
        ? listExternalItems(turns, { limit: 1, sortDirection: "desc" }).backwardsCursor
        : null;
      await this.#writer.json(
        rpcEnvelope(request, {
          result: {
            ...result,
            initialTurnsPage,
            turnsBackwardsCursor,
            itemsBackwardsCursor,
          },
        }),
      );
      if (params.excludeTurns !== true) this.#markExternalHistoryRead(thread, turns);
      else if (initialTurnsPage) this.#markExternalHistoryRead(thread, initialTurnsPage.data);
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalHistoryRequestError ? -32602 : -32076,
          error instanceof ExternalHistoryRequestError
            ? error.message
            : "External Thread history projection failed",
        ),
      );
    }
  }

  #externalHistoryTurns(thread: ExternalThread, forClient = false): JsonObject[] {
    const turns = this.#withOpenBackgroundCommands(thread, thread.turns);
    if (!thread.activeTurnId || (forClient && thread.ephemeralTurnIds.has(thread.activeTurnId)))
      return turns;
    const active = thread.projectedTurns.get(thread.activeTurnId);
    return active
      ? [...turns, forClient ? active.projector.snapshotTurn() : active.projector.pendingTurn()]
      : turns;
  }

  /**
   * Background commands whose native task has not settled overlay their live
   * wire state (`inProgress`, accumulated output) onto the served history Turn
   * they detached from, replacing the historical Item or appending to the Turn.
   */
  #withOpenBackgroundCommands(thread: ExternalThread, turns: JsonObject[]): JsonObject[] {
    return turns.map((turn) => {
      const open = thread.projectedTurns
        .get((turn as { id: HostTurnId }).id)
        ?.projector.openDetachedWireItems();
      if (!open || open.size === 0) return turn;
      const remaining = new Map(open);
      const items = (turn as { items: JsonObject[] }).items.map((item) => {
        const id = (item as { id: HostItemId }).id;
        const live = remaining.get(id);
        if (!live) return item;
        remaining.delete(id);
        return live;
      });
      return {
        ...turn,
        items: [...items, ...remaining.values()],
      };
    });
  }

  #externalThreadBusy(thread: ExternalThread): boolean {
    return thread.running || this.#externalSteering.hasPending(thread.id);
  }

  async #startDelegatedExternalTurn(
    thread: ExternalThread,
    text: string,
    requestedTurnId: string,
  ): Promise<void> {
    if (this.#externalThreadBusy(thread)) {
      throw new Error("External Thread already has an active Turn");
    }
    const turnId = hostTurnIdSchema.parse(requestedTurnId);
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs: Date.now(),
        initialInput: [{ type: "text", text }],
      }),
    };
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTerminalTurnId = null;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, {
      promise: Promise.resolve(),
      resolve: () => undefined,
    });
    const result = await thread.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text }],
    });
    if (!result.ok) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      this.#signalActiveWorkChanged();
      throw new Error(result.error.message);
    }
  }

  async #startExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    const params = requestObject(request);
    if (typeof params.model === "string") {
      let route: ReturnType<typeof decodeCreateRoute>;
      try {
        route = decodeCreateRoute({ id: request.id, method: "thread/start", params });
      } catch (error) {
        await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
        return;
      }
      if (route?.harnessId !== "codex" && route?.harnessId !== thread.harnessId) {
        await this.#writer.json(
          rpcError(request, -32602, "Turn Model carrier does not belong to the Thread Harness"),
        );
        return;
      }
    }
    let text: string;
    try {
      text = requestText(params);
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    const clientRequest = String(request.id).startsWith(this.#clientRequestPrefix);
    const queueRequested = clientRequest && params.delivery === "queue";
    if (
      queueRequested &&
      (this.#externalThreadBusy(thread) ||
        this.#pendingExternalCommandRequests.has(thread.id) ||
        this.#externalQueue.has(thread.id))
    ) {
      try {
        const queuedSubmission = this.#externalQueue.add(
          thread.id,
          requestInput(params),
          typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
          requestPresentationInput(params),
          params[THREAD_REFERENCE_SOURCE_HOST_PARAM],
        );
        await this.#publishExternalQueue(thread.id);
        await this.#writer.json(
          rpcEnvelope(request, { result: { queued: true, queuedSubmission } }),
        );
        if (!this.#externalThreadBusy(thread) && !this.#externalQueue.isPaused(thread.id))
          void this.#startNextQueuedExternalTurn(thread);
      } catch (error) {
        await this.#writer.json(rpcError(request, -32072, errorMessage(error)));
      }
      return;
    }
    if (this.#externalThreadBusy(thread) || this.#pendingExternalCommandRequests.has(thread.id)) {
      await this.#writer.json(
        rpcError(request, -32072, "External Thread already has an active Turn"),
      );
      return;
    }
    try {
      const started = await this.#beginExternalInputTurn(
        thread,
        text,
        undefined,
        typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
        clientRequest,
        params[THREAD_REFERENCE_SOURCE_HOST_PARAM],
      );
      try {
        await this.#writer.json(rpcEnvelope(request, { result: { turn: started.turn } }));
      } finally {
        started.gate.resolve();
      }
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError || error instanceof ExternalCommandError
            ? error.code
            : -32073,
          errorMessage(error),
        ),
      );
    }
  }

  async #publishExternalQueue(threadId: string): Promise<void> {
    this.clientEvents.changed(threadId, "codexhost/thread/queue/updated");
    await this.#writer.json({ method: "thread/queue/changed", params: { threadId } });
  }

  async #startNextQueuedExternalTurn(thread: ExternalThread): Promise<void> {
    if (
      this.#closeRequested ||
      this.#externalRuntime.get(thread.id) !== thread ||
      this.#externalThreadBusy(thread) ||
      this.#pendingExternalCommandRequests.has(thread.id) ||
      this.#externalQueue.isPaused(thread.id)
    )
      return;
    const next = this.#externalQueue.head(thread.id);
    if (!next) return;
    try {
      const started = await this.#startQueuedExternalTurn(thread, next.id);
      started.gate.resolve();
    } catch (error) {
      this.#diagnose(`Queued External Turn failed to start: ${errorMessage(error)}`);
      if (this.#externalQueue.pause(thread.id, "failed"))
        await this.#publishExternalQueue(thread.id);
    }
  }

  async #handleExternalQueueRequest(
    request: JsonRpcRequest,
    thread: ExternalThread,
  ): Promise<void> {
    const params = requestObject(request);
    const itemId =
      typeof params.queuedSubmissionId === "string"
        ? params.queuedSubmissionId
        : request.method === "thread/queue/start" && params.queuedSubmissionId == null
          ? this.#externalQueue.head(thread.id)?.id
          : undefined;
    try {
      if (request.method === "thread/queue/list") {
        await this.#writer.json(
          rpcEnvelope(request, {
            result: this.#externalQueue.list(thread.id, params),
          }),
        );
        return;
      }
      if (request.method === "thread/queue/add") {
        requestText(params);
        const queuedSubmission = this.#externalQueue.add(
          thread.id,
          requestInput(params),
          typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
          requestPresentationInput(params),
          params[THREAD_REFERENCE_SOURCE_HOST_PARAM],
        );
        await this.#publishExternalQueue(thread.id);
        await this.#writer.json(
          rpcEnvelope(request, {
            result: { queuedSubmission: nativeQueuedSubmission(queuedSubmission) },
          }),
        );
        const lastTurn = thread.turns.at(-1);
        if (
          thread.projectedTerminalTurnId === lastTurn?.id &&
          lastTurn?.status === "completed" &&
          isRecord(thread.thread.status) &&
          thread.thread.status.type === "idle"
        )
          void this.#startNextQueuedExternalTurn(thread);
        return;
      }
      if (request.method === "thread/queue/reorder") {
        const ids = params.queuedSubmissionIds;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
          throw new ExternalSteerError(-32602, "Queued submission order is invalid");
        if (!this.#externalQueue.reorder(thread.id, ids as string[]))
          throw new ExternalSteerError(-32072, "Queued messages changed before reordering");
        await this.#publishExternalQueue(thread.id);
        await this.#writer.json(rpcEnvelope(request, { result: {} }));
        return;
      }
      if (!itemId) throw new ExternalSteerError(-32602, "Queued submission identity is required");
      if (request.method === "thread/queue/update") {
        requestText(params);
        const queuedSubmission = this.#externalQueue.update(
          thread.id,
          itemId,
          requestInput(params),
          requestPresentationInput(params),
        );
        if (!queuedSubmission) throw new ExternalSteerError(-32072, "Queued message not found");
        await this.#publishExternalQueue(thread.id);
        await this.#writer.json(
          rpcEnvelope(request, {
            result: { queuedSubmission: nativeQueuedSubmission(queuedSubmission) },
          }),
        );
        return;
      }
      if (request.method === "thread/queue/delete") {
        const deleted = this.#externalQueue.delete(thread.id, itemId);
        if (deleted) await this.#publishExternalQueue(thread.id);
        await this.#writer.json(rpcEnvelope(request, { result: { deleted } }));
        return;
      }
      if (request.method === "thread/queue/start") {
        if (this.#externalThreadBusy(thread))
          throw new ExternalSteerError(-32072, "External Thread already has an active Turn");
        const started = await this.#startQueuedExternalTurn(thread, itemId);
        try {
          await this.#writer.json(rpcEnvelope(request, { result: { turn: started.turn } }));
        } finally {
          started.gate.resolve();
        }
        return;
      }
      throw new ExternalSteerError(-32601, "Unsupported External Thread queue method");
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError || error instanceof ExternalCommandError
            ? error.code
            : error instanceof ExternalQueueError
              ? error.code
              : -32072,
          errorMessage(error),
        ),
      );
    }
  }

  async #startQueuedExternalTurn(
    thread: ExternalThread,
    itemId: string,
  ): Promise<{ turnId: HostTurnId; turn: JsonObject; gate: TurnProjectionGate }> {
    const active = this.#queuedTurnStarts.get(thread.id);
    if (active) {
      if (active.itemId !== itemId)
        throw new ExternalSteerError(-32072, "Another queued message is already starting");
      return active.result;
    }
    if (this.#externalThreadBusy(thread) || this.#pendingExternalCommandRequests.has(thread.id))
      throw new ExternalSteerError(-32072, "External Thread already has an active Turn");
    const item = this.#externalQueue.find(thread.id, itemId);
    if (!item) throw new ExternalSteerError(-32072, "Queued message not found");
    const result = (async () => {
      const started = await this.#beginExternalInputTurn(
        thread,
        requestText({ input: item.input }),
        undefined,
        item.clientUserMessageId,
        true,
        item.sourceHostId,
      );
      this.#externalQueue.resume(thread.id);
      if (this.#externalQueue.delete(thread.id, item.id))
        await this.#publishExternalQueue(thread.id);
      return started;
    })();
    this.#queuedTurnStarts.set(thread.id, { itemId, result });
    try {
      return await result;
    } catch (error) {
      if (this.#queuedTurnStarts.get(thread.id)?.result === result)
        this.#queuedTurnStarts.delete(thread.id);
      throw error;
    }
  }

  async #sendQueuedExternalTurnNow(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    const params = requestObject(request);
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    if (!itemId) {
      await this.#writer.json(rpcError(request, -32602, "Queued message identity is required"));
      return;
    }
    const item = this.#externalQueue.find(thread.id, itemId);
    if (!item) {
      await this.#writer.json(rpcError(request, -32072, "Queued message not found"));
      return;
    }
    try {
      const started = this.#externalThreadBusy(thread)
        ? await this.#externalSteering.run(
            thread,
            {
              expectedTurnId: thread.activeTurnId,
              input: item.input,
              clientUserMessageId: item.clientUserMessageId,
            },
            (text, assertActive) =>
              this.#beginExternalInputTurn(
                thread,
                text,
                assertActive,
                item.clientUserMessageId,
                true,
                item.sourceHostId,
              ),
            (input) => this.#insertExternalInput(thread, input),
          )
        : await this.#startQueuedExternalTurn(thread, item.id);
      if (this.#externalQueue.find(thread.id, item.id)) {
        this.#externalQueue.resume(thread.id);
        this.#externalQueue.delete(thread.id, item.id);
        await this.#publishExternalQueue(thread.id);
      }
      try {
        await this.#writer.json(
          rpcEnvelope(request, { result: { sent: true, turnId: started.turnId } }),
        );
      } finally {
        started.gate.resolve();
      }
    } catch (error) {
      if (!thread.running && !thread.activeTurnId && this.#externalQueue.pause(thread.id, "failed"))
        await this.#publishExternalQueue(thread.id);
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError || error instanceof ExternalCommandError
            ? error.code
            : -32073,
          errorMessage(error),
        ),
      );
    }
  }

  async #steerExternalTurn(request: JsonRpcRequest, thread: ExternalThread): Promise<void> {
    const params = requestObject(request);
    if (
      String(request.id).startsWith(this.#clientRequestPrefix) &&
      (!thread.running || !thread.activeTurnId || this.#externalSteering.hasPending(thread.id))
    ) {
      // DSH treats Steer as best-effort. If its live steering window has
      // closed, preserve the input in the canonical queue instead of failing.
      const queuedRequest = jsonRpcRequestSchema.parse({
        id: request.id,
        method: "turn/start",
        params: { ...params, delivery: "queue" },
      });
      await this.#startExternalTurn(queuedRequest, thread);
      return;
    }
    try {
      const started = await this.#externalSteering.run(
        thread,
        params,
        (text, assertActive) =>
          this.#beginExternalInputTurn(
            thread,
            text,
            assertActive,
            typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
            String(request.id).startsWith(this.#clientRequestPrefix),
            params[THREAD_REFERENCE_SOURCE_HOST_PARAM],
          ),
        (input) => this.#insertExternalInput(thread, input),
      );
      try {
        await this.#writer.json(
          rpcEnvelope(request, {
            result: { turnId: started.turnId, delivery: started.delivery },
          }),
        );
      } finally {
        started.gate.resolve();
      }
    } catch (error) {
      await this.#writer.json(
        rpcError(
          request,
          error instanceof ExternalSteerError || error instanceof ExternalCommandError
            ? error.code
            : -32074,
          errorMessage(error),
        ),
      );
    } finally {
      this.#signalActiveWorkChanged();
    }
  }

  /** Native same-Turn input; `insertNativeSteer` owns the delivery and its fallback signal. */
  async #insertExternalInput(
    thread: ExternalThread,
    input: { turnId: HostTurnId; text: string; clientUserMessageId?: string },
  ): Promise<{ turnId: HostTurnId; gate: TurnProjectionGate }> {
    await insertNativeSteer(thread, input, {
      project: async (turnId, item, clientUserMessageId) => {
        const projection = projectedTurn(thread, turnId);
        if (clientUserMessageId) {
          projection.projector.bindUserMessageClientId(item.itemId, clientUserMessageId);
        }
        await this.#projectHarnessOutput(thread, {
          kind: "event",
          event: { type: "item.started", turnId, item },
        });
        await this.#projectHarnessOutput(thread, {
          kind: "event",
          event: {
            type: "item.completed",
            turnId,
            snapshot: { item, outcome: { status: "succeeded" } },
          },
        });
      },
      diagnose: (error) => this.#diagnose(error),
    });
    return {
      turnId: input.turnId,
      gate: { promise: Promise.resolve(), resolve: () => undefined },
    };
  }

  /** Keep command restoration and dispatch identical for start and steer submissions. */
  async #beginExternalInputTurn(
    thread: ExternalThread,
    inputText: string,
    assertActive?: () => void,
    clientUserMessageId?: string,
    publishInput = false,
    sourceHostId?: unknown,
  ): Promise<{ turnId: HostTurnId; turn: JsonObject; gate: TurnProjectionGate }> {
    const text = restoreHarnessCommandMentions(inputText);
    const commands = thread.session.commands;
    if (!commands || !isExternalCommandCandidate(text)) {
      assertActive?.();
      return this.#beginExternalTurn(thread, text, clientUserMessageId, publishInput, sourceHostId);
    }
    this.#pendingExternalCommandRequests.add(thread.id);
    try {
      const adapter = this.#externalAdapters.get(thread.harnessId);
      const command = await resolveExternalCommand(commands, text, {
        liveCatalogPending: (catalog) =>
          adapter?.liveCommandCatalog === true &&
          !isLiveCommandCatalog(catalog, adapter.commandCatalog ?? { commands: [] }),
      });
      assertActive?.();
      if (!command) {
        this.#pendingExternalCommandRequests.delete(thread.id);
        return await this.#beginExternalTurn(
          thread,
          text,
          clientUserMessageId,
          publishInput,
          sourceHostId,
        );
      }
      return await this.#beginExternalCommand(
        thread,
        command.descriptor,
        command.arguments,
        undefined,
        sourceHostId,
      );
    } catch (error) {
      if (error instanceof ExternalCommandError || error instanceof ExternalSteerError) throw error;
      this.#diagnose(error);
      throw new ExternalCommandError(
        -32073,
        `External Harness command failed: ${errorMessage(error)}`,
      );
    } finally {
      this.#pendingExternalCommandRequests.delete(thread.id);
      if (!thread.running && !thread.activeTurnId && this.#externalQueue.pause(thread.id, "failed"))
        await this.#publishExternalQueue(thread.id);
    }
  }

  /** Apply context before native execution; a rejected start restores the prior identity. */
  #setExecutionHost(thread: ExternalThread, sourceHostId: unknown): () => void {
    const previousHostId = this.#executionHosts.get(thread);
    if (
      typeof sourceHostId === "string" &&
      sourceHostId.length > 0 &&
      sourceHostId.length <= 1024 &&
      !/[\u0000-\u0020\u007f]/u.test(sourceHostId)
    ) {
      this.#executionHosts.set(thread, sourceHostId);
    } else {
      this.#executionHosts.delete(thread);
    }
    return () => {
      if (previousHostId === undefined) this.#executionHosts.delete(thread);
      else this.#executionHosts.set(thread, previousHostId);
    };
  }

  /**
   * Desktop renders the input of its own `turn/start` locally. Other starts (Host-only clients
   * and queued follow-ups) need the user message projected with the Turn.
   */
  async #beginExternalTurn(
    thread: ExternalThread,
    text: string,
    clientUserMessageId?: string,
    publishInput = false,
    sourceHostId?: unknown,
  ): Promise<{
    turnId: HostTurnId;
    turn: JsonObject;
    gate: TurnProjectionGate;
  }> {
    if (this.#closeRequested || this.#externalRuntime.get(thread.id) !== thread) {
      throw new ExternalSteerError(-32073, "External Thread is no longer available");
    }
    if (
      thread.running ||
      thread.activeTurnId ||
      this.#pendingExternalCommandRequests.has(thread.id)
    ) {
      throw new ExternalSteerError(-32072, "External Thread already has an active Turn");
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const startedAtMs = Date.now();
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs,
        snapshotInput: [{ type: "text", text }],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        ...(this.#options.externalOnly || publishInput
          ? { initialInput: [{ type: "text" as const, text }] }
          : {}),
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTerminalTurnId = null;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);

    const restoreExecutionHost = this.#setExecutionHost(thread, sourceHostId);
    try {
      if (thread.unsubmittedPrewarm && (await this.#externalRuntime.submitPrewarm(thread))) {
        await this.#notifyExternalThreadStarted(thread.thread);
      }
      const result = await thread.session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: rewriteDelegationMentionText(text) }],
      });
      if (!result.ok) throw new ExternalSteerError(-32073, result.error.message);
      await this.#externalRuntime.capturePreview(thread, projection.projector.snapshotTurn());
      return { turnId, turn: projection.projector.pendingTurn(), gate };
    } catch (error) {
      restoreExecutionHost();
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      gate.resolve();
      this.#signalActiveWorkChanged();
      throw error;
    }
  }

  /**
   * Desktop's "stop all background terminals". An unloaded Thread has no
   * Session and therefore no background terminals; a loaded Harness that
   * cannot stop them, or a failed stop, is an error rather than success.
   */
  async #cleanExternalBackgroundTerminals(
    request: JsonRpcRequest,
    threadId: string,
  ): Promise<void> {
    const thread = this.#externalRuntime.get(threadId);
    if (!thread) {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
      return;
    }
    if (!thread.session.stopBackgroundWork) {
      await this.#writer.json(
        rpcError(
          request,
          -32076,
          "External Harness does not support stopping background terminals",
        ),
      );
      return;
    }
    const result = await thread.session.stopBackgroundWork();
    if (!result.ok) {
      await this.#writer.json(rpcError(request, -32083, result.error.message));
      return;
    }
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
  }

  async #interruptExternalTurn(
    request: JsonRpcRequest,
    thread: ExternalThread,
    requestedTurnId: JsonValue | undefined,
  ): Promise<void> {
    if (typeof requestedTurnId === "string")
      this.#externalSteering.interrupt(thread.id, requestedTurnId);
    if (
      typeof requestedTurnId !== "string" ||
      !thread.running ||
      thread.activeTurnId !== requestedTurnId
    ) {
      await this.#writer.json(
        rpcError(request, -32074, "External turn/interrupt must reference the active Turn"),
      );
      return;
    }
    const turnId = thread.activeTurnId;
    const cancellationGate = turnProjectionGate();
    const gate: TurnProjectionGate = {
      promise: Promise.all([
        thread.responseGates.get(turnId)?.promise ?? Promise.resolve(),
        cancellationGate.promise,
      ]).then(() => undefined),
      resolve: cancellationGate.resolve,
    };
    thread.responseGates.set(turnId, gate);
    const result = await thread.session.execute({ type: "turn.cancel", turnId });
    if (!result.ok) {
      try {
        await this.#writer.json(rpcError(request, -32074, result.error.message));
      } finally {
        gate.resolve();
      }
      return;
    }
    try {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } finally {
      gate.resolve();
    }
  }

  async #consumeHarnessOutputs(thread: ExternalThread): Promise<void> {
    try {
      for await (const output of thread.session.outputs) {
        await this.#externalRuntime.idleRelease.consumeOutput(thread, () =>
          this.#projectHarnessOutput(thread, output),
        );
      }
    } catch (error) {
      this.#externalRuntime.idleRelease.outputFailed(thread);
      this.#diagnose(error);
      this.#externalSteering.fault(thread.id, new Error(errorMessage(error)));
      await settleExternalOutputFailure(
        thread,
        error,
        (output) => this.#projectHarnessOutput(thread, output),
        (failure) => this.#diagnose(failure),
      );
    } finally {
      this.#externalSteering.fault(
        thread.id,
        new Error("External Harness output ended before replacement"),
      );
      if (
        !this.#closeRequested &&
        (thread.running || thread.activeTurnId) &&
        this.#externalQueue.pause(thread.id, "outcome-unknown")
      ) {
        this.#queuedTurnStarts.delete(thread.id);
        await this.#publishExternalQueue(thread.id);
      }
    }
  }

  async #projectHarnessOutput(thread: ExternalThread, output: HarnessOutput): Promise<void> {
    if (output.kind === "interaction") {
      if (output.interaction.type === "approval") {
        await this.#projectApproval(thread, output.interaction);
      } else {
        await this.#projectQuestion(thread, output.interaction);
      }
      return;
    }
    let event = output.event;
    if (this.#meterTurnTiming(thread, event)) await this.#notifyThreadUsage(thread);
    if (event.type === "item.started" && event.item.type === "subagentDelegation") {
      event = {
        ...event,
        item: {
          ...event.item,
          subagents: await Promise.all(
            event.item.subagents.map((subagent) =>
              this.#materializeSubagent(thread, subagent).catch(() => subagent),
            ),
          ),
        },
      };
    }
    if (event.type === "item.updated" && event.update.type === "subagents.replace") {
      event = {
        ...event,
        update: {
          ...event.update,
          subagents: await Promise.all(
            event.update.subagents.map((subagent) =>
              this.#materializeSubagent(thread, subagent).catch(() => subagent),
            ),
          ),
        },
      };
    }
    if (event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation") {
      event = {
        ...event,
        snapshot: {
          ...event.snapshot,
          item: {
            ...event.snapshot.item,
            subagents: await Promise.all(
              event.snapshot.item.subagents.map((subagent) =>
                this.#materializeSubagent(thread, subagent).catch(() => subagent),
              ),
            ),
          },
        },
      };
    }
    if (event.type === "session.state.changed") {
      try {
        if (event.state.nativeRef) {
          const nativeRef = thread.record.nativeSessionRef ?? thread.stateObserver.state.nativeRef;
          if (
            nativeRef &&
            (nativeRef.harnessId !== event.state.nativeRef.harnessId ||
              nativeRef.nativeSessionId !== event.state.nativeRef.nativeSessionId)
          ) {
            throw new Error("External Session changed Native identity");
          }
          if (!thread.record.nativeSessionRef && !thread.unsubmittedPrewarm) {
            thread.record = await this.#repository.commitNative(thread.id, event.state.nativeRef);
            await this.#notifyExternalThreadStarted(thread.thread);
          }
        }
        thread.stateObserver.update(event.state);
        this.clientEvents.changed(thread.id, "codexhost/thread/configuration/updated");
      } catch (error) {
        thread.persistenceError = error instanceof Error ? error : new Error(errorMessage(error));
        thread.stateObserver.fault(thread.persistenceError);
        this.#diagnose("External Session state could not be persisted");
      }
      return;
    }
    if (event.type === "session.usage.changed") {
      if (this.#externalRuntime.get(thread.id) !== thread) return;
      thread.latestUsage = event.usage;
      if (event.usage === null) {
        thread.usageTurnId = null;
        await this.#writer.json({
          method: THREAD_USAGE_UPDATED_METHOD,
          params: { threadId: thread.id },
        });
        return;
      }
      const turnId = event.observedForTurnId
        ? this.#isKnownExternalTurn(thread, event.observedForTurnId)
          ? event.observedForTurnId
          : null
        : (thread.activeTurnId ?? this.#latestCompletedTurnId(thread));
      thread.usageTurnId = turnId;
      if (turnId) {
        await waitForTurnResponse(thread, turnId);
        await this.#writeExternalUsage(thread, turnId);
      }
      await this.#writer.json({
        method: THREAD_USAGE_UPDATED_METHOD,
        params: { threadId: thread.id },
      });
      return;
    }
    if (event.type === "usage.request" || event.type === "usage.history") {
      if (this.#externalRuntime.get(thread.id) !== thread) return;
      if (event.type === "usage.request") {
        const changed = thread.usageMeter.recordRequest(event.request, thread.activeTurnId);
        // Replayed history is announced once by the following usage.history.
        if (!changed || event.request.historical === true) return;
      } else {
        thread.usageMeter.recordHistory(event.complete);
      }
      await this.#notifyThreadUsage(thread);
      return;
    }
    if (event.type === "subagent.transcript.changed") {
      const nativeSubagentId = event.nativeSubagentId;
      const record = (await this.#repository.list()).find(
        (candidate) =>
          candidate.subagent?.parentHostThreadId === thread.id &&
          candidate.subagent.nativeSubagentId === nativeSubagentId &&
          candidate.nativeSessionRef?.nativeSessionId ===
            thread.record.nativeSessionRef?.nativeSessionId,
      );
      if (record) await this.#refreshOpenSubagentThread(record.hostThreadId, false);
      return;
    }
    if (event.type === "subagent.state.changed") {
      const nativeSubagentId = event.nativeSubagentId;
      const record = (await this.#repository.list()).find(
        (candidate) =>
          candidate.subagent?.parentHostThreadId === thread.id &&
          candidate.subagent.nativeSubagentId === nativeSubagentId &&
          candidate.nativeSessionRef?.nativeSessionId ===
            thread.record.nativeSessionRef?.nativeSessionId,
      );
      if (!record) return;
      const status = event.status === "pending" || event.status === "running" ? "active" : "idle";
      this.#trackRunningSubagent(thread.id, record.hostThreadId, status);
      await this.#setSubagentThreadStatus(record.hostThreadId, status);
      if (!thread.running && !thread.activeTurnId && !this.#hasRunningSubagents(thread.id)) {
        await this.#setThreadStatus(thread, { type: "idle" });
      }
      return;
    }
    if (event.type === "session.faulted") {
      this.#queuedTurnStarts.delete(thread.id);
      this.#retireSharedQuestions(thread);
      this.#externalSteering.fault(thread.id, new Error(event.error.message));
      thread.stateObserver.fault(new Error(event.error.message));
      this.#externalRuntime.markSessionUnavailable(thread);
      if (this.#externalQueue.pause(thread.id, "outcome-unknown"))
        await this.#publishExternalQueue(thread.id);
      this.#diagnose(`${thread.harnessId} Harness Session faulted: ${event.error.message}`);
      // Idle Threads must not keep a dead Session; the next open restores from disk.
      if (
        !thread.running &&
        !thread.activeTurnId &&
        !this.#hasRunningSubagents(thread.id) &&
        !thread.session.hasBackgroundWork?.()
      ) {
        // Do not await: discard drains this outputTask. Runtime synchronously admits the
        // cleanup to its Thread lifecycle barrier so resolve/refresh cannot bypass it.
        void this.#externalRuntime.discardUnavailableIdle(thread);
      }
      return;
    }

    await this.#turnProjection.project(thread, event);
  }

  async #materializeSubagent(
    parent: ExternalThread,
    subagent: HostSubagentState,
  ): Promise<HostSubagentState> {
    if (!subagent.nativeSubagentId || !parent.record.nativeSessionRef) return subagent;
    const status =
      subagent.status === "pending" || subagent.status === "running" ? "active" : "idle";
    const record = await this.#repository.materializeSubagent(parent.record, subagent);
    if (!record) return subagent;
    if (this.#subagentThreadStatuses.has(record.hostThreadId)) {
      this.#trackRunningSubagent(parent.id, record.hostThreadId, status);
      await this.#setSubagentThreadStatus(record.hostThreadId, status);
      return { ...subagent, subagentId: record.hostThreadId };
    }
    const thread = externalThreadValue({
      record,
      turns: [],
      sessionId: parent.sessionId,
      running: status === "active",
    });
    this.#subagentThreadStatuses.set(record.hostThreadId, status);
    this.#trackRunningSubagent(parent.id, record.hostThreadId, status);
    await this.#writer.json({
      method: "thread/started",
      emittedAtMs: Date.now(),
      params: { thread },
    });
    return { ...subagent, subagentId: record.hostThreadId };
  }

  async #refreshOpenSubagentThread(threadId: string, terminal = true): Promise<void> {
    await this.#desktopRequests.run(threadId, async () => {
      await this.#refreshOpenSubagentThreadBody(threadId, terminal);
    });
  }

  async #refreshOpenSubagentThreadBody(threadId: string, terminal: boolean): Promise<void> {
    const child = this.#externalRuntime.get(threadId);
    if (!child) return;
    const previousItems = new Map(
      child.turns.flatMap((turn) =>
        Array.isArray(turn.items)
          ? turn.items.flatMap((item) =>
              isRecord(item) && typeof item.id === "string"
                ? ([[item.id, JSON.stringify(item)]] as const)
                : [],
            )
          : [],
      ),
    );
    const refreshed = await this.#refreshExternalThread(child);
    if (refreshed) {
      this.#diagnose(refreshed.message);
      return;
    }
    const emittedAtMs = Date.now();
    for (const turn of child.turns) {
      if (typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
      const changedItems = turn.items.filter(
        (item): item is JsonObject =>
          isRecord(item) &&
          typeof item.id === "string" &&
          previousItems.get(item.id) !== JSON.stringify(item),
      );
      if (changedItems.length > 0) {
        await this.#writer.json({
          method: "turn/started",
          emittedAtMs,
          params: {
            threadId,
            turn: {
              ...turn,
              status: "inProgress",
              completedAt: null,
              durationMs: null,
            },
          },
        });
      }
      for (const item of changedItems) {
        await this.#writer.json({
          method: "item/started",
          emittedAtMs,
          params: {
            threadId,
            turnId: turn.id,
            startedAtMs: emittedAtMs,
            item,
          },
        });
        await this.#writer.json({
          method: "item/completed",
          emittedAtMs,
          params: {
            threadId,
            turnId: turn.id,
            completedAtMs: emittedAtMs,
            item,
          },
        });
      }
      if (terminal) {
        await this.#writer.json({
          method: "turn/completed",
          emittedAtMs,
          params: { threadId, turn },
        });
      }
    }
  }

  #trackRunningSubagent(
    parentThreadId: string,
    childThreadId: string,
    status: "active" | "idle",
  ): void {
    let running = this.#runningSubagentsByParent.get(parentThreadId);
    if (status === "active") {
      if (!running) {
        running = new Set();
        this.#runningSubagentsByParent.set(parentThreadId, running);
      }
      running.add(childThreadId);
      return;
    }
    if (!running) return;
    running.delete(childThreadId);
    if (running.size === 0) this.#runningSubagentsByParent.delete(parentThreadId);
    this.#signalActiveWorkChanged();
  }

  #hasRunningSubagents(parentThreadId: string): boolean {
    return (this.#runningSubagentsByParent.get(parentThreadId)?.size ?? 0) > 0;
  }

  async #setSubagentThreadStatus(threadId: string, status: "active" | "idle"): Promise<void> {
    const previousStatus = this.#subagentThreadStatuses.get(threadId);
    const child = this.#externalRuntime.get(threadId);
    if (child) {
      child.running = status === "active";
      if (status === "idle") child.historyHydrated = false;
      child.thread = externalThreadValue({
        record: child.record,
        turns: child.turns,
        sessionId: child.sessionId,
        running: child.running,
      });
    }
    if (status === "idle" && previousStatus === "active") {
      for (const [index, waitMs] of SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.entries()) {
        if (waitMs > 0) await delay(waitMs);
        await this.#refreshOpenSubagentThread(
          threadId,
          index === SUBAGENT_TERMINAL_REFRESH_DELAYS_MS.length - 1,
        );
      }
    }
    if (previousStatus === status) return;
    this.#subagentThreadStatuses.set(threadId, status);
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: {
        threadId,
        status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
      },
    });
  }

  async #projectApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<void> {
    const projection = projectedTurn(thread, interaction.turnId);
    await waitForTurnResponse(thread, interaction.turnId);
    let result: CodexApprovalProjection;
    try {
      result = projection.projector.projectApproval(
        interaction,
        this.#pluginDescriptors.find(({ id }) => id === thread.harnessId)?.name ??
          this.#pluginDescriptors.find(({ id }) => id === thread.harnessId)?.name ??
          thread.harnessId,
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const denied = await this.#denyApproval(thread, interaction);
      if (!denied) thread.ignoredInteractionIds.delete(interaction.interactionId);
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateApprovalRequestId();
    const pending: PendingDesktopApproval = {
      thread,
      interaction,
      projection: result.approvalRequest,
    };
    this.#pendingDesktopApprovals.set(requestId, pending);
    try {
      await this.#writer.json({ id: requestId, ...result.approvalRequest.request });
    } catch (error) {
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#denyApproval(thread, interaction);
      throw error;
    }
  }

  async #handleDesktopApprovalResponse(value: JsonValue): Promise<boolean> {
    if (!isRecord(value) || !isHostApprovalRequestId(value.id)) return false;
    const requestId = value.id;
    const pending = this.#pendingDesktopApprovals.get(requestId);
    if (!pending) return true;
    return this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return true;
      if (this.#pendingDesktopApprovals.get(requestId) !== pending) return true;
      await this.#resolveDesktopApproval(pending.interaction.interactionId, pending.thread);

      let response: HostApprovalResponse;
      try {
        response =
          "error" in value
            ? pending.projection.denyResponse
            : pending.projection.parseResponse(value.result);
      } catch (error) {
        this.#diagnose(error);
        response = pending.projection.denyResponse;
      }
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response,
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Approval response failed: ${result.error.message}`);
        const cancelled = await pending.thread.session.execute({
          type: "turn.cancel",
          turnId: pending.interaction.turnId,
        });
        if (!cancelled.ok && cancelled.error.code !== "invalidState") {
          this.#diagnose(`Approval fail-closed cancellation failed: ${cancelled.error.message}`);
        }
      }
      return true;
    });
  }

  async #denyApproval(
    thread: ExternalThread,
    interaction: HostApprovalInteraction,
  ): Promise<boolean> {
    const denyActions = interaction.actions.filter(({ effect }) => effect === "deny");
    if (denyActions.length !== 1) {
      const cancelled = await thread.session.execute({
        type: "turn.cancel",
        turnId: interaction.turnId,
      });
      if (!cancelled.ok) {
        this.#diagnose(`Unsupported Approval cancellation failed: ${cancelled.error.message}`);
      }
      return cancelled.ok;
    }
    const action = denyActions[0];
    if (!action) return false;
    const denied = await thread.session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "approval", actionId: action.id },
    });
    if (!denied.ok) {
      this.#diagnose(`Unsupported Approval denial failed: ${denied.error.message}`);
    }
    return denied.ok;
  }

  async #resolveThreadInteractions(thread: ExternalThread): Promise<void> {
    for (const pending of [...this.#pendingDesktopApprovals.values()]) {
      if (pending.thread === thread)
        await this.#resolveDesktopApproval(pending.interaction.interactionId, thread);
    }
    for (const pending of [...this.#pendingDesktopQuestions.values()]) {
      if (pending.thread === thread)
        await this.#resolveDesktopQuestion(pending.interaction.interactionId, thread);
    }
  }

  async #resolveDesktopApproval(
    interactionId: HostInteractionId,
    thread: ExternalThread,
  ): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopApprovals) {
      if (pending.thread !== thread || pending.interaction.interactionId !== interactionId)
        continue;
      this.#pendingDesktopApprovals.delete(requestId);
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateApprovalRequestId(): HostApprovalRequestId {
    if (this.#nextApprovalRequestId < HOST_APPROVAL_REQUEST_ID_MIN) {
      throw new Error("Host Approval Request ID namespace is exhausted");
    }
    const requestId = this.#nextApprovalRequestId;
    this.#nextApprovalRequestId -= 1;
    return requestId;
  }

  #retireSharedQuestions(thread: ExternalThread, turnId?: HostTurnId): void {
    for (const pending of [...this.#pendingDesktopQuestions.values()]) {
      if (
        pending.shared &&
        pending.thread === thread &&
        (turnId === undefined || pending.interaction.turnId === turnId)
      )
        this.#retireDesktopQuestion(pending.interaction.interactionId, thread);
    }
  }

  async #handleSharedQuestionRequest(request: JsonRpcRequest): Promise<void> {
    const responding = request.method === THREAD_QUESTION_RESPOND_METHOD;
    const parsed = (
      responding ? threadQuestionRespondParamsSchema : threadQuestionsListParamsSchema
    ).safeParse(request.params);
    if (!parsed.success) {
      await this.#writer.json(rpcError(request, -32602, "Invalid Question params"));
      return;
    }
    const { threadId } = parsed.data;
    const thread = this.#externalRuntime.get(threadId);
    const pendingQuestions = () =>
      [...this.#pendingDesktopQuestions.values()].filter(
        (pending) =>
          pending.shared &&
          pending.thread === thread &&
          pending.interaction.turnId === thread?.activeTurnId &&
          (!Number.isFinite(Date.parse(pending.interaction.expiresAt ?? "")) ||
            Date.parse(pending.interaction.expiresAt ?? "") > Date.now()),
      );
    if (!responding) {
      const questions =
        thread && !thread.sessionUnavailable && !this.#externalRuntime.idleRelease.failure(thread)
          ? pendingQuestions().map((pending) => sharedQuestion(pending.interaction))
          : [];
      await this.#writer.json(
        rpcEnvelope(request, { result: jsonValueSchema.parse({ questions }) }),
      );
      return;
    }
    const params = threadQuestionRespondParamsSchema.parse(parsed.data);
    try {
      await this.#externalRuntime.idleRelease.runOperation(threadId, async () => {
        const pending = pendingQuestions().find(
          ({ interaction }) =>
            interaction.interactionId === params.interactionId &&
            interaction.turnId === params.turnId,
        );
        if (
          !thread ||
          this.#externalRuntime.get(threadId) !== thread ||
          thread.sessionUnavailable ||
          this.#externalRuntime.idleRelease.failure(thread) ||
          !pending ||
          pending.responding
        ) {
          throw new Error("Question is no longer pending on this Thread and Turn");
        }
        const response = {
          type: "question" as const,
          answers: params.answers,
          cancelled: params.cancelled,
        };
        validateSharedQuestionResponse(pending.interaction, response);
        pending.responding = true;
        let result;
        try {
          result = await thread.session.execute({
            type: "interaction.respond",
            interactionId: pending.interaction.interactionId,
            response,
          });
        } catch (error) {
          // Delivery is ambiguous; never permit a second write of the same answer.
          this.#retireDesktopQuestion(pending.interaction.interactionId, thread);
          throw error;
        }
        if (!result.ok) {
          pending.responding = false;
          if (result.error.code === "invalidState")
            this.#retireDesktopQuestion(pending.interaction.interactionId, thread);
          throw new Error(result.error.message);
        }
        this.#retireDesktopQuestion(pending.interaction.interactionId, thread);
        await this.#writer.json(rpcEnvelope(request, { result: { accepted: true } }));
      });
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
    }
  }

  async #projectQuestion(
    thread: ExternalThread,
    interaction: HostQuestionInteraction,
  ): Promise<void> {
    const projection = projectedTurn(thread, interaction.turnId);
    await waitForTurnResponse(thread, interaction.turnId);
    let result: CodexQuestionProjection;
    const shared = usesSharedQuestionCard(interaction);
    try {
      if (shared) sharedQuestion(interaction);
      result = projection.projector.projectQuestion(
        interaction,
        hostItemIdSchema.parse(randomUUID()),
      );
    } catch (error) {
      this.#diagnose(error);
      thread.ignoredInteractionIds.add(interaction.interactionId);
      const cancelled = await thread.session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      });
      if (!cancelled.ok) {
        thread.ignoredInteractionIds.delete(interaction.interactionId);
        this.#diagnose(`Unsupported Question cancellation failed: ${cancelled.error.message}`);
      }
      return;
    }
    for (const message of result.messages) await this.#writer.json(message);

    const requestId = this.#allocateQuestionRequestId();
    const expiresAtMs = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
    const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : null;
    const pending: PendingDesktopQuestion = {
      shared,
      responding: false,
      thread,
      interaction,
      projection: result.questionRequest,
      timeout: null,
    };
    if (timeoutMs !== null) {
      pending.timeout = setTimeout(() => {
        void this.#cancelExpiredQuestion(requestId).catch((error) => this.#diagnose(error));
      }, timeoutMs);
    }
    this.#pendingDesktopQuestions.set(requestId, pending);
    // Multi-select groups use shared cards, not Desktop's native single-choice card.
    if (shared) {
      this.clientEvents.changed(thread.id, "codexhost/thread/questions/updated");
      return;
    }
    try {
      await this.#writer.json({ id: requestId, ...result.questionRequest.request });
    } catch (error) {
      this.#retireDesktopQuestion(interaction.interactionId, thread);
      await thread.session
        .execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: {}, cancelled: true },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #handleDesktopQuestionResponse(value: JsonValue, fromClient = false): Promise<boolean> {
    if (!isRecord(value) || !isHostQuestionRequestId(value.id)) return false;
    const requestId = value.id;
    const pending = this.#pendingDesktopQuestions.get(requestId);
    if (!pending) return true;
    if (pending.shared) {
      if (!fromClient) return true;
      const response = pending.projection.parseResponse(value.result);
      const reply = await this.#handleControlRequest(
        THREAD_QUESTION_RESPOND_METHOD,
        jsonValueSchema.parse({
          threadId: pending.thread.id,
          turnId: pending.interaction.turnId,
          interactionId: pending.interaction.interactionId,
          answers: response.answers,
          ...(response.cancelled ? { cancelled: true } : {}),
        }) as JsonObject,
        CONSOLE_REQUEST_TIMEOUT_MS,
        "client",
      );
      if ("error" in reply) throw new Error(reply.error.message);
      return true;
    }
    return this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return true;
      if (this.#pendingDesktopQuestions.get(requestId) !== pending) return true;
      await this.#resolveDesktopQuestion(pending.interaction.interactionId, pending.thread);
      if (pending.timeout) clearTimeout(pending.timeout);

      let response;
      try {
        response =
          "error" in value
            ? { type: "question" as const, answers: {}, cancelled: true as const }
            : pending.projection.parseResponse(value.result);
      } catch (error) {
        this.#diagnose(error);
        response = { type: "question" as const, answers: {}, cancelled: true as const };
      }
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response,
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Question response failed: ${result.error.message}`);
      }
      return true;
    });
  }

  async #cancelExpiredQuestion(requestId: HostQuestionRequestId): Promise<void> {
    const pending = this.#pendingDesktopQuestions.get(requestId);
    if (!pending) return;
    await this.#externalRuntime.idleRelease.runOperation(pending.thread.id, async () => {
      if (this.#pendingDesktopQuestions.get(requestId) !== pending) return;
      if (
        this.#externalRuntime.get(pending.thread.id) !== pending.thread ||
        this.#externalRuntime.idleRelease.failure(pending.thread)
      )
        return;
      await this.#resolveDesktopQuestion(pending.interaction.interactionId, pending.thread);
      if (pending.responding) return;
      const result = await pending.thread.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      });
      if (!result.ok && result.error.code !== "invalidState") {
        this.#diagnose(`Question expiry failed: ${result.error.message}`);
      }
    });
  }

  #retireDesktopQuestion(interactionId: HostInteractionId, thread: ExternalThread): void {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.thread !== thread || pending.interaction.interactionId !== interactionId)
        continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
      if (pending.shared)
        this.clientEvents.changed(thread.id, "codexhost/thread/questions/updated");
    }
  }

  async #resolveDesktopQuestion(
    interactionId: HostInteractionId,
    thread: ExternalThread,
  ): Promise<void> {
    for (const [requestId, pending] of this.#pendingDesktopQuestions) {
      if (pending.thread !== thread || pending.interaction.interactionId !== interactionId)
        continue;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.#pendingDesktopQuestions.delete(requestId);
      if (pending.shared) {
        this.clientEvents.changed(thread.id, "codexhost/thread/questions/updated");
        continue;
      }
      await this.#writer.json({
        method: "serverRequest/resolved",
        params: { threadId: pending.thread.id, requestId },
      });
    }
  }

  #allocateQuestionRequestId(): HostQuestionRequestId {
    if (this.#nextQuestionRequestId < HOST_QUESTION_REQUEST_ID_MIN) {
      throw new Error("Host Question Request ID namespace is exhausted");
    }
    const requestId = this.#nextQuestionRequestId;
    this.#nextQuestionRequestId -= 1;
    return requestId;
  }

  async #setThreadStatus(thread: ExternalThread, status: ExternalThreadStatus): Promise<void> {
    thread.thread.status = status;
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: { threadId: thread.id, status },
    });
  }

  #latestCompletedTurnId(thread: ExternalThread): HostTurnId | null {
    const parsed = hostTurnIdSchema.safeParse(thread.turns.at(-1)?.id);
    return parsed.success ? parsed.data : null;
  }

  #isKnownExternalTurn(thread: ExternalThread, turnId: HostTurnId): boolean {
    return thread.projectedTurns.has(turnId) || thread.turns.some((turn) => turn.id === turnId);
  }

  /** Native snapshot plus Host-derived metering; metering faults never hide native fields. */
  async #threadUsage(thread: ExternalThread): Promise<HostUsage | null> {
    try {
      const usage = thread.usageMeter.derive(thread.latestUsage, await this.#modelPrices.lookup());
      // An unpriced model may have been listed since the price table was fetched.
      if (usage?.unpricedModels?.length) this.#modelPrices.missing();
      return usage;
    } catch (error) {
      this.#diagnose(error);
      return thread.latestUsage;
    }
  }

  async #notifyThreadUsage(thread: ExternalThread): Promise<void> {
    await this.#writer.json({
      method: THREAD_USAGE_UPDATED_METHOD,
      params: { threadId: thread.id },
    });
  }

  /** Host-observed Turn timing; returns true when a derived metric changed. */
  #meterTurnTiming(thread: ExternalThread, event: HostEvent): boolean {
    if (this.#externalRuntime.get(thread.id) !== thread) return false;
    return thread.usageMeter.observeTurn(event);
  }

  async #replayExternalUsage(thread: ExternalThread): Promise<void> {
    const latestTurnId = this.#latestCompletedTurnId(thread);
    if (!latestTurnId || !thread.latestUsage) return;
    thread.usageTurnId = latestTurnId;
    await this.#writeExternalUsage(thread, latestTurnId);
  }

  async #writeExternalUsage(thread: ExternalThread, turnId: HostTurnId): Promise<void> {
    const usage = thread.latestUsage;
    if (!usage || this.#externalRuntime.get(thread.id) !== thread) return;
    const projection = projectCodexThreadUsage({ threadId: thread.id, turnId, usage });
    if (!projection) return;
    await waitForTurnResponse(thread, turnId);
    if (
      this.#externalRuntime.get(thread.id) !== thread ||
      thread.latestUsage !== usage ||
      thread.usageTurnId !== turnId
    ) {
      return;
    }
    await this.#writer.json(projection);
  }

  #dispatchDesktopRequest(run: () => Promise<void>, threadId?: string): void {
    try {
      const task = threadId ? this.#externalRuntime.idleRelease.runOperation(threadId, run) : run();
      void task.catch((error) => this.#diagnose(error));
    } catch (error) {
      this.#diagnose(error);
    }
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
