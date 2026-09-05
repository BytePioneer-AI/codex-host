import { createTwoFilesPatch, parsePatch } from "diff";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessAdapter,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSubagentCapability,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HarnessThinkingOptionId,
  type InspectHarnessInput,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostContextCompactionItem,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostSubagentDelegationItem,
  type HostSubagentState,
  type HostSubagentStatus,
  type HostToolOutput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type HostThreadSnapshot,
  type HostUsage,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { mapOmpSnapshot, resolveOmpForkBoundary, type OmpSessionHistory } from "./omp-history.js";
import { rollbackOmpLastTurn } from "./omp-last-turn-rollback.js";
import {
  OmpRpcFaultError,
  OmpRpcSession,
  OmpRpcUnsupportedCommandError,
  type OmpInteractionRequest,
  type OmpInteractionResponse,
  type OmpRpcSessionOptions,
  type OmpSessionState,
  type OmpCompactResult,
  type OmpSubagentMessagesResult,
  type OmpTurnEvent,
  type OmpTurnResult,
} from "./omp-rpc-session.js";
import {
  decodeOmpModelRef,
  encodeOmpModelRef,
  normalizeOmpModelCatalog,
  normalizeOmpThinkingOptions,
  sameOmpModel,
  type OmpNativeModel,
  type OmpNativeModelRef,
} from "./omp-model-catalog.js";
import {
  decodeOmpPermissionModeId,
  encodeOmpPermissionModeId,
  OMP_DEFAULT_PERMISSION_MODE_ID,
  OMP_PERMISSION_MODE_CATALOG,
  type OmpPermissionMode,
} from "./omp-permission-modes.js";
import { OmpSubagentLifecycle } from "./omp-subagent-lifecycle.js";
import { projectOmpToolItem } from "./omp-tool-presentation.js";

export interface OmpAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  compactionTimeoutMs?: number;
  cancelTimeoutMs?: number;
  closeTimeoutMs?: number;
  toolOutputLimit?: number;
}

export interface OmpTurnTransport {
  readonly state: OmpSessionState;
  readonly stderrTail?: string;
  start(): Promise<unknown>;
  getAvailableModels(): Promise<OmpNativeModel[]>;
  getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[] | null>;
  getEntries(): Promise<OmpSessionHistory>;
  getSubagentMessages(input: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }): Promise<OmpSubagentMessagesResult>;
  getSessionUsage(): Promise<HostUsage | null>;
  fork(entryId: string): Promise<OmpSessionState>;
  verifySessionCwd(expectedCwd: string): Promise<void>;
  selectModel(model: OmpNativeModelRef): Promise<OmpSessionState>;
  selectThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<OmpSessionState>;
  compact(
    customInstructions: string | undefined,
    onEvent: (event: OmpTurnEvent) => void,
  ): Promise<OmpCompactResult>;
  runTurn(text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult>;
  respondToInteraction(response: OmpInteractionResponse): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface OmpAdapterDependencies {
  createTransport(options: OmpRpcSessionOptions): OmpTurnTransport;
}

interface ActiveTool {
  item: HostCommandExecutionItem;
  nativeName: string;
  arguments: JsonValue;
  startedAtMs: number;
}

interface ActiveInteraction {
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  nativeRequest: OmpInteractionRequest;
}

interface ActiveTurn {
  command: TurnStartCommand;
  agentItem: HostAgentMessageItem | null;
  agentMessageId: string | null;
  compactionItem: HostContextCompactionItem | null;
  sawAssistantMessage: boolean;
  reasoningItem: HostReasoningItem | null;
  tools: Map<string, ActiveTool>;
  interactions: Map<HostInteractionId, ActiveInteraction>;
  interactionByNativeId: Map<string, HostInteractionId>;
  subagents: OmpSubagentLifecycle;
  cancellationRequested: boolean;
  beforeNativeTurnKeys: Set<string>;
  completion: Promise<void>;
  resolveCompletion(): void;
}

interface BackgroundSubagentDelegation {
  item: HostSubagentDelegationItem;
  turnId: HostTurnId;
}

type SessionPhase = "open" | "closing" | "closed" | "faulted";

const ompHarnessId = harnessIdSchema.parse("omp");
const ompCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "omp.compact",
      invocation: "/compact",
      label: "Compact context",
      description: "Compact the current conversation context",
      argumentMode: "text",
    },
  ],
});
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OmpAdapterFaultError extends Error {
  constructor(readonly harnessError: HarnessError) {
    super(harnessError.message);
    this.name = "OmpAdapterFaultError";
  }
}

function normalizedError(error: unknown, fallbackCode: HarnessError["code"]): HarnessError {
  if (isRecord(error) && error.code === "ENOENT") {
    return { code: "notInstalled", message: errorMessage(error), retryable: false };
  }
  if (error instanceof OmpAdapterFaultError) return error.harnessError;
  if (error instanceof OmpRpcUnsupportedCommandError) {
    return {
      code: "unsupported",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof OmpRpcFaultError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: error.kind !== "notInstalled",
      ...(error.diagnostic ? { stderrTail: error.diagnostic } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: errorMessage(error),
    retryable: fallbackCode === "unavailable" || fallbackCode === "nativeFailure",
  };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function nativeModelFromState(state: OmpSessionState): OmpNativeModelRef | null {
  if (state.provider === null && state.modelId === null) return null;
  if (state.provider === null || state.modelId === null) {
    throw new OmpRpcFaultError("protocolError", "Omp state contains a partial Model identity");
  }
  return { provider: state.provider, id: state.modelId };
}

function effectiveModelFromState(state: OmpSessionState): HarnessModelRef | undefined {
  const model = nativeModelFromState(state);
  return model ? encodeOmpModelRef(model) : undefined;
}

function harnessStateFromOmp(
  state: OmpSessionState,
  thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  permissionModeId?: HarnessPermissionModeId,
): HarnessSessionState {
  const effectiveModel = effectiveModelFromState(state);
  const availableThinkingOptions = thinkingLevels
    ? normalizeOmpThinkingOptions(thinkingLevels)
    : undefined;
  if (
    availableThinkingOptions &&
    (!state.thinkingLevel || !thinkingLevels?.includes(state.thinkingLevel))
  ) {
    throw new OmpRpcFaultError(
      "protocolError",
      "Omp effective Thinking level is absent from its available levels",
    );
  }
  return {
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: ompHarnessId,
      nativeSessionId: state.sessionId,
      ...(state.sessionFile ? { locator: { sessionFile: state.sessionFile } } : {}),
      formatVersion: 1,
    }) as NativeSessionRef,
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(state.thinkingLevel ? { effectiveThinkingOptionId: state.thinkingLevel } : {}),
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
    ...(permissionModeId ? { effectivePermissionModeId: permissionModeId } : {}),
  };
}

/**
 * OMP can retain the previous model's Thinking level when it silently falls
 * back to another model. Normalize that stale value before publishing the
 * Session state so a recoverable Native Session is not rejected by the
 * Host-side state invariant.
 */
async function reconcileThinkingLevel(
  transport: OmpTurnTransport,
  state: OmpSessionState,
  thinkingLevels: HarnessThinkingOptionId[] | null,
): Promise<{ state: OmpSessionState; thinkingLevels: HarnessThinkingOptionId[] | null }> {
  if (
    thinkingLevels === null ||
    (state.thinkingLevel !== null && thinkingLevels.includes(state.thinkingLevel))
  ) {
    return { state, thinkingLevels };
  }

  const fallback = thinkingLevels.find((level) => level === "high") ?? thinkingLevels.at(-1);
  if (!fallback) return { state, thinkingLevels };

  const selectedState = await transport.selectThinkingOption(fallback);
  return {
    state: selectedState,
    thinkingLevels: await transport.getAvailableThinkingLevels(),
  };
}

function nativeModelForHistory(state: OmpSessionState): OmpNativeModelRef | null {
  return nativeModelFromState(state);
}

function sessionFileFromRef(ref: NativeSessionRef): string {
  if (
    ref.harnessId !== ompHarnessId ||
    !isRecord(ref.locator) ||
    typeof ref.locator.sessionFile !== "string" ||
    ref.locator.sessionFile.length === 0
  ) {
    throw new Error("Omp Native Session Ref has no resumable Session file");
  }
  return ref.locator.sessionFile;
}

function toolFailure(toolName: string): HarnessError {
  return {
    code: "nativeFailure",
    message: `Omp Tool '${toolName}' failed`,
    retryable: false,
  };
}

function nativeText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter(
      (content): content is Record<string, JsonValue> =>
        isRecord(content) && content.type === "text" && typeof content.text === "string",
    )
    .map(({ text }) => text as string)
    .join("");
}

function boundedOutput(value: JsonValue, limit: number): HostToolOutput | undefined {
  const text = nativeText(value);
  if (text.length === 0) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

function outputText(output: HostToolOutput | undefined): string {
  return (
    output?.content
      .filter(
        (content): content is Extract<(typeof output.content)[number], { type: "text" }> =>
          content.type === "text",
      )
      .map(({ text }) => text)
      .join("") ?? ""
  );
}

function stringField(value: JsonValue, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "string" && field.length > 0) return field;
  if (isRecord(value.input)) {
    const nested = value.input[key];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  if (isRecord(value.arguments)) {
    const nested = value.arguments[key];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

function numberField(value: JsonValue, key: string): number | null | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" || field === null ? field : undefined;
}

function stripDiffPrefix(pathString: string | undefined): string {
  if (typeof pathString !== "string" || pathString.length === 0) return "";
  return pathString.startsWith("a/") || pathString.startsWith("b/")
    ? pathString.slice(2)
    : pathString;
}

function displayPath(nativePath: string, cwd: string): { path: string; absolute: boolean } | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.isAbsolute(nativePath)
    ? path.resolve(nativePath)
    : path.resolve(cwd, nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const inside = relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  const selected = inside ? relative : resolvedPath;
  const normalized = selected.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized === ".") return null;
  return { path: normalized, absolute: !inside };
}

function fileMutatingKind(toolName: string): "edit" | "write" | null {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  if (
    [
      "edit",
      "editfile",
      "fileedit",
      "strreplace",
      "searchreplace",
      "applypatch",
      "replace",
    ].includes(lower)
  ) {
    return "edit";
  }
  if (["write", "writefile", "filewrite", "create", "createfile"].includes(lower)) return "write";
  return null;
}

function nestedToolString(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  for (const wrapper of ["input", "arguments", "params", "details"] as const) {
    const nested = nestedToolString(value[wrapper], keys);
    if (nested) return nested;
  }
  return undefined;
}

function patchFromResult(result: JsonValue): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of ["patch", "diff", "unifiedDiff"] as const) {
    const field = result[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  if (isRecord(result.details)) {
    for (const key of ["patch", "diff", "unifiedDiff"] as const) {
      const field = result.details[key];
      if (typeof field === "string" && field.length > 0) return field;
    }
  }
  return undefined;
}

function fileChangeFromPatch(patch: string, cwd: string): HostFileChange[] | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return null;
  }
  const file = parsed[0];
  if (parsed.length !== 1 || !file) return null;
  const oldFile = typeof file.oldFileName === "string" ? file.oldFileName : undefined;
  const newFile = typeof file.newFileName === "string" ? file.newFileName : undefined;
  if (!oldFile && !newFile) return null;
  const kind =
    oldFile === "/dev/null" || !oldFile
      ? "add"
      : newFile === "/dev/null" || !newFile
        ? "delete"
        : "update";
  const candidate = kind === "delete" ? oldFile : (newFile ?? oldFile);
  const rawPath = stripDiffPrefix(candidate);
  if (!rawPath || rawPath === "/dev/null") return null;
  const displayed = displayPath(rawPath, cwd);
  if (!displayed) return null;
  return [{ path: displayed.path, kind, unifiedDiff: patch }];
}

function synthesizeFileChange(
  kind: "edit" | "write",
  args: unknown,
  cwd: string,
): HostFileChange[] | null {
  const filePath = nestedToolString(args, ["path", "file_path", "filePath", "file"]);
  if (!filePath) return null;
  const displayed = displayPath(filePath, cwd);
  if (!displayed) return null;
  if (kind === "write") {
    const content = nestedToolString(args, [
      "content",
      "new_string",
      "newString",
      "newText",
      "text",
    ]);
    if (content === undefined) return null;
    const oldHeader = "/dev/null";
    const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
    return [
      {
        path: displayed.path,
        kind: "add",
        unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, "", content, "", "", { context: 3 }),
      },
    ];
  }
  const oldText = nestedToolString(args, ["old_string", "oldString", "oldText", "old_text"]);
  const newText = nestedToolString(args, [
    "new_string",
    "newString",
    "newText",
    "new_text",
    "content",
  ]);
  if (oldText === undefined || newText === undefined) return null;
  const oldHeader = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return [
    {
      path: displayed.path,
      kind: "update",
      unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, oldText, newText, "", "", {
        context: 3,
      }),
    },
  ];
}

function reliableFileChange(
  toolName: string,
  args: unknown,
  result: JsonValue,
  cwd: string,
): HostFileChange[] | null {
  const kind = fileMutatingKind(toolName);
  if (!kind) return null;
  const patch = patchFromResult(result);
  if (patch) {
    const fromPatch = fileChangeFromPatch(patch, cwd);
    if (fromPatch) return fromPatch;
  }
  return synthesizeFileChange(kind, args, cwd) ?? synthesizeFileChange(kind, result, cwd);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class OmpHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = ompHarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly commands: HarnessCommandCapability;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #closeTimeoutMs: number;
  readonly #createTransport: OmpAdapterDependencies["createTransport"];
  readonly #cwd: string;
  readonly #onClosed: () => void;
  readonly #requestedModel: HarnessModelRef | undefined;
  readonly #requestedThinkingOptionId: HarnessThinkingOptionId | undefined;
  readonly #toolOutputLimit: number;
  #permissionMode: OmpPermissionMode;
  #permissionModeId: HarnessPermissionModeId;
  #acceptingTurn = false;
  #active: ActiveTurn | null = null;
  #closePromise: Promise<void> | null = null;
  #configuring = false;
  #phase: SessionPhase = "open";
  #starting: Promise<OmpTurnTransport> | null = null;
  #state: HarnessSessionState = {};
  #transport: OmpTurnTransport | null = null;
  #usage: HostUsage | null;
  #usageGeneration = 0;
  #usageRefreshSequence = 0;
  #backgroundTurnId: HostTurnId | null = null;
  #backgroundSubagents = new Map<string, BackgroundSubagentDelegation>();
  #backgroundTurnFailed = false;

  constructor(
    cwd: string,
    createTransport: OmpAdapterDependencies["createTransport"],
    onClosed: () => void,
    options: {
      closeTimeoutMs: number;
      model?: HarnessModelRef;
      thinkingOptionId?: HarnessThinkingOptionId;
      toolOutputLimit: number;
      supportsThinkingSelection: boolean;
      permissionMode: OmpPermissionMode;
      permissionModeId: HarnessPermissionModeId;
      startedTransport?: OmpTurnTransport;
      startedThinkingLevels?: HarnessThinkingOptionId[] | null;
      initialUsage?: HostUsage | null;
    },
  ) {
    this.#cwd = cwd;
    this.#createTransport = createTransport;
    this.#onClosed = onClosed;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#requestedModel = options.model;
    this.#requestedThinkingOptionId = options.thinkingOptionId;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.#permissionMode = options.permissionMode;
    this.#permissionModeId = options.permissionModeId;
    this.capabilities = {
      configuration: {
        selectModel: true,
        selectThinkingOption: options.supportsThinkingSelection,
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
      subagents: { observe: true, readTranscript: true },
    };
    this.commands = {
      list: async () => ({ ok: true, value: ompCommandCatalog }),
      execute: (command) => this.#executeHarnessCommand(command),
    };
    this.#transport = options.startedTransport ?? null;
    this.initialState = options.startedTransport
      ? harnessStateFromOmp(
          options.startedTransport.state,
          options.startedThinkingLevels ?? null,
          this.#permissionModeId,
        )
      : { effectivePermissionModeId: this.#permissionModeId };
    this.initialUsage = options.initialUsage ?? null;
    this.#usage = this.initialUsage;
    this.#state = this.initialState;
    this.outputs = this.#channel.outputs;
  }

  handleTransportFault(error: OmpRpcFaultError): void {
    queueMicrotask(() => this.#fault(error));
  }

  handleTransportEvent(event: OmpTurnEvent): void {
    if (this.#phase !== "open") return;
    if (this.#active) return;
    this.#handleBackgroundSubagentEvent(event);
  }

  #backgroundStatus(
    status: Extract<OmpTurnEvent, { type: "subagent.updated" }>["status"],
  ): HostSubagentStatus {
    return status === "pending" || status === "running"
      ? "running"
      : status === "interrupted"
        ? "interrupted"
        : status;
  }

  #ensureBackgroundTurn(): HostTurnId {
    if (this.#backgroundTurnId) return this.#backgroundTurnId;
    const turnId = hostTurnIdSchema.parse(randomUUID());
    this.#backgroundTurnId = turnId;
    this.#backgroundTurnFailed = false;
    this.#event({
      type: "turn.autonomous.started",
      turnId,
      input: [],
    });
    return turnId;
  }

  #backgroundDelegationStart(
    event:
      | Extract<OmpTurnEvent, { type: "subagent.started" }>
      | Extract<OmpTurnEvent, { type: "subagent.updated" }>
      | Extract<OmpTurnEvent, { type: "subagent.completed" }>,
  ): BackgroundSubagentDelegation {
    const turnId = this.#ensureBackgroundTurn();
    const description =
      event.type === "subagent.started"
        ? event.description
        : event.type === "subagent.updated"
          ? (event.description ?? "Background subagent")
          : "Background subagent";
    const role = event.type === "subagent.started" ? event.role : undefined;
    const background = event.type === "subagent.started" ? event.background : true;
    const state: HostSubagentState = {
      subagentId: event.nativeSubagentId,
      nativeSubagentId: event.nativeSubagentId,
      description,
      ...(role ? { role } : {}),
      background,
      status: "running",
    };
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: "spawn",
      ...(event.type === "subagent.started" && event.prompt ? { prompt: event.prompt } : {}),
      subagents: [state],
    };
    const delegation = { item, turnId };
    this.#backgroundSubagents.set(event.callId, delegation);
    this.#event({ type: "item.started", turnId, item });
    return delegation;
  }

  #handleBackgroundSubagentEvent(event: OmpTurnEvent): void {
    if (event.type === "subagent.transcript.changed") {
      this.#event({
        type: "subagent.transcript.changed",
        nativeSubagentId: event.nativeSubagentId,
      });
      return;
    }
    if (
      event.type !== "subagent.started" &&
      event.type !== "subagent.updated" &&
      event.type !== "subagent.completed"
    ) {
      return;
    }
    let delegation = this.#backgroundSubagents.get(event.callId);
    if (!delegation) delegation = this.#backgroundDelegationStart(event);
    const current = delegation.item.subagents[0];
    if (!current) throw new Error("Omp background delegation has no Agent state");
    if (event.type === "subagent.started") {
      this.#event({
        type: "subagent.state.changed",
        nativeSubagentId: event.nativeSubagentId,
        status: "running",
      });
      return;
    }
    if (event.type === "subagent.updated") {
      const status = this.#backgroundStatus(event.status);
      const subagent: HostSubagentState = {
        ...current,
        status,
        ...(event.description ? { description: event.description } : {}),
        ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      };
      delegation.item = { ...delegation.item, subagents: [subagent] };
      this.#event({
        type: "item.updated",
        turnId: delegation.turnId,
        itemId: delegation.item.itemId,
        update: { type: "subagents.replace", subagents: delegation.item.subagents },
      });
      this.#event({
        type: "subagent.state.changed",
        nativeSubagentId: event.nativeSubagentId,
        status,
        ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      });
      return;
    }
    const status: HostSubagentStatus = event.isError ? "failed" : "completed";
    const subagent: HostSubagentState = {
      ...current,
      status,
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    };
    delegation.item = { ...delegation.item, subagents: [subagent] };
    this.#event({
      type: "item.updated",
      turnId: delegation.turnId,
      itemId: delegation.item.itemId,
      update: { type: "subagents.replace", subagents: delegation.item.subagents },
    });
    this.#event({
      type: "item.completed",
      turnId: delegation.turnId,
      snapshot: {
        item: delegation.item,
        outcome: event.isError
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "Omp background Subagent failed",
                retryable: false,
              },
            }
          : { status: "succeeded" },
      },
    });
    this.#event({
      type: "subagent.state.changed",
      nativeSubagentId: event.nativeSubagentId,
      status,
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    });
    this.#backgroundTurnFailed ||= event.isError;
    this.#backgroundSubagents.delete(event.callId);
    if (this.#backgroundSubagents.size === 0 && this.#backgroundTurnId === delegation.turnId) {
      const turnId = this.#backgroundTurnId;
      this.#backgroundTurnId = null;
      this.#event({
        type: "turn.completed",
        turnId,
        outcome: this.#backgroundTurnFailed
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "Omp background Subagent failed",
                retryable: false,
              },
            }
          : { status: "succeeded" },
      });
      this.#backgroundTurnFailed = false;
    }
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Omp Session is not open") };
    }
    if (this.#active || this.#acceptingTurn || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session cannot read history while another operation is active",
          retryable: true,
        },
      };
    }
    try {
      const transport = await this.#ensureTransport();
      const history = await transport.getEntries();
      return {
        ok: true,
        value: {
          ...mapOmpSnapshot(history, {
            sessionId: transport.state.sessionId,
            model: nativeModelForHistory(transport.state),
          }),
          state: this.#state,
        },
      };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("Omp Session is not open") };
    }
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "interaction.respond") return this.#respond(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session already has an active Turn",
          retryable: true,
        },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Omp text Turn must not be empty",
          retryable: false,
        },
      };
    }

    this.#acceptingTurn = true;
    try {
      // A still-null transport means this call is about to perform the Native
      // Session's first-ever spawn (plain `create`, no resume/fork). Such a
      // Session provably has no prior Turns yet, so there is nothing to read:
      // Omp allocates the future Session file path before it exists on disk,
      // and racing that with a history read here is what produces ENOENT.
      const isInitialSpawn = this.#transport === null;
      let transport: OmpTurnTransport;
      try {
        transport = await this.#ensureTransport();
      } catch (error) {
        return { ok: false, error: normalizedError(error, "unavailable") };
      }
      if (this.#phase !== "open") {
        return { ok: false, error: invalidState("Omp Session became unavailable during startup") };
      }

      let beforeHistory: HostThreadSnapshot;
      if (isInitialSpawn) {
        beforeHistory = { turns: [] };
      } else {
        try {
          beforeHistory = mapOmpSnapshot(await transport.getEntries(), {
            sessionId: transport.state.sessionId,
            model: nativeModelForHistory(transport.state),
          });
        } catch (error) {
          return { ok: false, error: normalizedError(error, "protocolError") };
        }
      }

      let resolveCompletion = (): void => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: this.#newItemId(),
        text: "",
      };
      const active: ActiveTurn = {
        command,
        agentItem: item,
        agentMessageId: null,
        compactionItem: null,
        sawAssistantMessage: false,
        reasoningItem: null,
        tools: new Map(),
        interactions: new Map(),
        interactionByNativeId: new Map(),
        subagents: new OmpSubagentLifecycle({
          newItemId: () => this.#newItemId(),
          emit: (event) => this.#event(event),
        }),
        cancellationRequested: false,
        beforeNativeTurnKeys: new Set(
          beforeHistory.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey),
        ),
        completion,
        resolveCompletion,
      };
      this.#active = active;
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#event({ type: "item.started", turnId: command.turnId, item });

      void transport
        .runTurn(text, (event) => this.#handleTurnEvent(active, event))
        .then(async (result) => {
          try {
            const identity = await this.#completedTurnIdentity(active, transport);
            this.#completeTurn(
              active,
              result.cancelled
                ? {
                    status: "cancelled",
                    reason: "Cancelled by user",
                    checkpoint: identity.checkpoint,
                  }
                : { status: "succeeded", checkpoint: identity.checkpoint },
              result.text,
              identity.nativeTurnRef,
            );
          } catch (error) {
            this.#completeTurn(active, {
              status: "failed",
              error: normalizedError(error, "protocolError"),
            });
          }
        })
        .catch(async (error: unknown) => {
          let identity:
            { nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef } | undefined;
          try {
            identity = await this.#completedTurnIdentity(active, transport);
          } catch {
            // A failed native Turn may not have persisted a stable User Entry.
          }
          this.#completeTurn(
            active,
            {
              status: "failed",
              error: normalizedError(error, "nativeFailure"),
              ...(identity ? { checkpoint: identity.checkpoint } : {}),
            },
            undefined,
            identity?.nativeTurnRef,
          );
        });

      return { ok: true, value: { turnId: command.turnId } };
    } finally {
      this.#acceptingTurn = false;
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().finally(this.#onClosed);
    }
    return this.#closePromise;
  }

  async #selectModel(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session cannot select a Model while another operation is active",
          retryable: true,
        },
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return {
        ok: false,
        error: invalidState("Omp Model selection requires a started Native Session"),
      };
    }
    let requested: OmpNativeModelRef;
    try {
      requested = decodeOmpModelRef(command.model);
    } catch (error) {
      return { ok: false, error: normalizedError(error, "invalidRequest") };
    }

    const previousModel = this.#state.effectiveModel;
    this.#configuring = true;
    try {
      let state: OmpSessionState;
      let thinkingLevels: HarnessThinkingOptionId[] | null;
      try {
        state = await transport.selectModel(requested);
        thinkingLevels = await transport.getAvailableThinkingLevels();
        const reconciled = await reconcileThinkingLevel(transport, state, thinkingLevels);
        state = reconciled.state;
        thinkingLevels = reconciled.thinkingLevels;
        this.#publishTransportState(state, thinkingLevels);
      } catch (error) {
        if (error instanceof OmpRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
      const actual = nativeModelFromState(state);
      const nextModel = effectiveModelFromState(state);
      if (previousModel?.id !== nextModel?.id) {
        this.#invalidateUsage();
        void this.#refreshUsage();
      }
      if (!sameOmpModel(actual, requested)) {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: "Omp did not activate the requested Model",
            retryable: false,
          },
        };
      }
      return { ok: true, value: { completed: true } };
    } finally {
      this.#configuring = false;
    }
  }

  async #selectThinking(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    if (!this.capabilities.configuration.selectThinkingOption) {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Omp Thinking selection is unavailable",
          retryable: false,
        },
      };
    }
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session cannot select Thinking while another operation is active",
          retryable: true,
        },
      };
    }
    const transport = this.#transport;
    if (!transport) {
      return {
        ok: false,
        error: invalidState("Omp Thinking selection requires a started Native Session"),
      };
    }
    const parsedThinkingOptionId = harnessThinkingOptionIdSchema.safeParse(
      command.thinkingOptionId,
    );
    if (!parsedThinkingOptionId.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Omp Thinking option is invalid",
          retryable: false,
        },
      };
    }
    const thinkingOptionId = parsedThinkingOptionId.data;
    this.#configuring = true;
    try {
      let state: OmpSessionState;
      let thinkingLevels: HarnessThinkingOptionId[] | null;
      try {
        state = await transport.selectThinkingOption(thinkingOptionId);
        thinkingLevels = await transport.getAvailableThinkingLevels();
      } catch (error) {
        if (error instanceof OmpRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
      if (!thinkingLevels) {
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Omp Thinking discovery became unavailable",
            retryable: false,
          },
        };
      }
      try {
        this.#publishTransportState(state, thinkingLevels);
      } catch (error) {
        if (error instanceof OmpRpcFaultError) this.#fault(error);
        return { ok: false, error: normalizedError(error, "protocolError") };
      }
      return { ok: true, value: { completed: true } };
    } finally {
      this.#configuring = false;
    }
  }

  async #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session cannot select Permission Mode while another operation is active",
          retryable: true,
        },
      };
    }
    let permissionMode: OmpPermissionMode;
    let permissionModeId: HarnessPermissionModeId;
    try {
      permissionModeId = harnessPermissionModeIdSchema.parse(command.permissionModeId);
      permissionMode = decodeOmpPermissionModeId(permissionModeId);
    } catch (error) {
      return { ok: false, error: normalizedError(error, "invalidRequest") };
    }
    if (permissionModeId === this.#permissionModeId) {
      return { ok: true, value: { completed: true } };
    }
    const transport = this.#transport;
    if (!transport) {
      this.#permissionMode = permissionMode;
      this.#permissionModeId = permissionModeId;
      this.#state = { ...this.#state, effectivePermissionModeId: permissionModeId };
      this.#event({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    }
    const sessionFile = transport.state.sessionFile;
    if (!sessionFile) {
      return {
        ok: false,
        error: invalidState("Omp Permission Mode selection requires a persisted Native Session"),
      };
    }
    this.#configuring = true;
    const nativeSessionId = transport.state.sessionId;
    const transportOptions = (mode: OmpPermissionMode): OmpRpcSessionOptions => ({
      cwd: this.#cwd,
      sessionFile,
      permissionMode: mode,
      onFault: (error) => queueMicrotask(() => this.#fault(error)),
      onSubagentEvent: (event) => this.handleTransportEvent(event),
    });
    try {
      let replacement: OmpTurnTransport | null = null;
      try {
        replacement = this.#createTransport(transportOptions(permissionMode));
        await transport.close();
        await replacement.start();
        if (replacement.state.sessionId !== nativeSessionId) {
          throw new Error("Omp Permission Mode restart changed the Native Session identity");
        }
        const thinkingLevels = await replacement.getAvailableThinkingLevels();
        this.#transport = replacement;
        this.#permissionMode = permissionMode;
        this.#permissionModeId = permissionModeId;
        this.#publishTransportState(replacement.state, thinkingLevels);
        return { ok: true, value: { completed: true } };
      } catch (error) {
        await replacement?.close().catch(() => undefined);
        let recovery: OmpTurnTransport | null = null;
        try {
          recovery = this.#createTransport(transportOptions(this.#permissionMode));
          await recovery.start();
          if (recovery.state.sessionId !== nativeSessionId) {
            throw new Error("Omp Permission Mode recovery changed the Native Session identity");
          }
          const thinkingLevels = await recovery.getAvailableThinkingLevels();
          this.#transport = recovery;
          this.#publishTransportState(recovery.state, thinkingLevels);
        } catch (recoveryError) {
          await recovery?.close().catch(() => undefined);
          this.#transport = null;
          this.#fault(
            new OmpAdapterFaultError({
              code: "nativeFailure",
              message: `Omp Permission Mode switch failed and the previous Session could not be recovered: ${errorMessage(recoveryError)}`,
              retryable: true,
            }),
          );
        }
        return { ok: false, error: normalizedError(error, "nativeFailure") };
      }
    } finally {
      this.#configuring = false;
    }
  }

  async #respond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return {
        ok: false,
        error: invalidState("Omp Interaction Response must reference a pending Interaction"),
      };
    }
    const transport = this.#transport;
    if (!transport) return { ok: false, error: invalidState("Omp transport is unavailable") };

    let response: OmpInteractionResponse;
    if (pending.interaction.type === "approval") {
      if (command.response.type !== "approval") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Omp Approval requires an Approval Response",
            retryable: false,
          },
        };
      }
      const validation = validateHostApprovalResponse(pending.interaction, command.response);
      if (validation) return { ok: false, error: validation };
      response = {
        requestId: pending.nativeRequest.requestId,
        value: command.response.actionId === "allow-once" ? "Approve" : "Deny",
      };
    } else {
      if (command.response.type !== "question") {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Omp Question requires a Question Response",
            retryable: false,
          },
        };
      }
      const validation = validateHostQuestionResponse(pending.interaction, command.response);
      if (validation) return { ok: false, error: validation };
      const answers = command.response.answers.answer ?? [];
      if (command.response.cancelled) {
        response = { requestId: pending.nativeRequest.requestId, cancelled: true };
      } else if (pending.nativeRequest.method === "confirm") {
        response = {
          requestId: pending.nativeRequest.requestId,
          confirmed: answers[0] === "yes",
        };
      } else {
        const value = answers[0];
        if (value === undefined) {
          return {
            ok: false,
            error: {
              code: "invalidRequest",
              message: "Omp Question Response has no answer",
              retryable: false,
            },
          };
        }
        response = { requestId: pending.nativeRequest.requestId, value };
      }
    }
    try {
      await transport.respondToInteraction(response);
      return { ok: true, value: { accepted: true } };
    } catch (error) {
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("Omp Turn Cancel must reference the active Turn"),
      };
    }
    if (active.cancellationRequested) {
      return { ok: true, value: { cancellationRequested: true } };
    }
    const transport = this.#transport;
    if (!transport) return { ok: false, error: invalidState("Omp transport is unavailable") };
    active.cancellationRequested = true;
    try {
      await transport.abort();
      return { ok: true, value: { cancellationRequested: true } };
    } catch (error) {
      const normalized = normalizedError(error, "nativeFailure");
      if (this.#active === active) {
        this.#fault(new OmpAdapterFaultError(normalized));
        void transport.close().catch(() => undefined);
      }
      return { ok: false, error: normalized };
    }
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (command.commandId !== "omp.compact") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `Omp does not expose Harness command '${command.commandId}'`,
          retryable: false,
        },
      };
    }
    if (this.#acceptingTurn || this.#active || this.#configuring) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Omp Session already has an active operation",
          retryable: true,
        },
      };
    }
    const arguments_ = command.arguments;
    const customInstructions = arguments_?.text;
    if (customInstructions !== undefined && typeof customInstructions !== "string") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Omp compact command argument 'text' must be a string",
          retryable: false,
        },
      };
    }
    if (arguments_ && Object.keys(arguments_).some((key) => key !== "text")) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Omp compact command has an unknown argument",
          retryable: false,
        },
      };
    }

    this.#acceptingTurn = true;
    try {
      let transport: OmpTurnTransport;
      try {
        transport = await this.#ensureTransport();
      } catch (error) {
        return { ok: false, error: normalizedError(error, "unavailable") };
      }
      const turnCommand: TurnStartCommand = {
        type: "turn.start",
        turnId: command.turnId,
        input: [],
      };
      let resolveCompletion = (): void => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const active: ActiveTurn = {
        command: turnCommand,
        agentItem: null,
        agentMessageId: null,
        compactionItem: null,
        sawAssistantMessage: false,
        reasoningItem: null,
        tools: new Map(),
        interactions: new Map(),
        interactionByNativeId: new Map(),
        subagents: new OmpSubagentLifecycle({
          newItemId: () => this.#newItemId(),
          emit: (event) => this.#event(event),
        }),
        cancellationRequested: false,
        beforeNativeTurnKeys: new Set(),
        completion,
        resolveCompletion,
      };
      this.#active = active;
      this.#event({ type: "turn.started", turnId: command.turnId });
      void transport
        .compact(customInstructions, (event) => this.#handleTurnEvent(active, event))
        .then((result) => {
          if (result.outcome === "succeeded") {
            this.#completeTurn(active, { status: "succeeded" });
          } else if (result.outcome === "cancelled") {
            this.#completeTurn(active, {
              status: "cancelled",
              reason: "Context compaction was cancelled",
            });
          } else {
            this.#completeTurn(active, {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: result.errorMessage ?? "Omp context compaction failed",
                retryable: true,
              },
            });
          }
        })
        .catch((error: unknown) => {
          this.#completeTurn(active, {
            status: "failed",
            error: normalizedError(error, "nativeFailure"),
          });
        });
      return { ok: true, value: { turnId: command.turnId } };
    } finally {
      this.#acceptingTurn = false;
    }
  }

  async #ensureTransport(): Promise<OmpTurnTransport> {
    if (this.#transport) return this.#transport;
    if (this.#starting) return this.#starting;
    const transport = this.#createTransport({
      cwd: this.#cwd,
      onFault: (error) => queueMicrotask(() => this.#fault(error)),
      onSubagentEvent: (event) => this.handleTransportEvent(event),
      permissionMode: this.#permissionMode,
    });
    const starting = transport
      .start()
      .then(async () => {
        if (this.#phase !== "open") throw new Error("Omp Session closed during startup");
        let state = transport.state;
        let thinkingLevels = await transport.getAvailableThinkingLevels();
        if (this.#requestedModel) {
          const requested = decodeOmpModelRef(this.#requestedModel);
          const current = nativeModelFromState(state);
          if (!sameOmpModel(current, requested)) state = await transport.selectModel(requested);
          thinkingLevels = await transport.getAvailableThinkingLevels();
          if (!sameOmpModel(nativeModelFromState(state), requested)) {
            this.#publishTransportState(state, thinkingLevels);
            throw new Error("Omp did not activate the requested create Model");
          }
        }
        if (this.#requestedThinkingOptionId) {
          if (!thinkingLevels) {
            throw new OmpAdapterFaultError({
              code: "unsupported",
              message: "Installed Omp does not support Thinking selection",
              retryable: false,
            });
          }
          state = await transport.selectThinkingOption(this.#requestedThinkingOptionId);
          thinkingLevels = await transport.getAvailableThinkingLevels();
        } else {
          const reconciled = await reconcileThinkingLevel(transport, state, thinkingLevels);
          state = reconciled.state;
          thinkingLevels = reconciled.thinkingLevels;
        }
        this.#transport = transport;
        this.#publishTransportState(state, thinkingLevels);
        return transport;
      })
      .catch(async (error: unknown) => {
        await transport.close().catch(() => undefined);
        if (this.#phase === "open") this.#fault(error);
        throw error;
      })
      .finally(() => {
        if (this.#starting === starting) this.#starting = null;
      });
    this.#starting = starting;
    return starting;
  }

  #publishTransportState(
    state: OmpSessionState,
    thinkingLevels: readonly HarnessThinkingOptionId[] | null,
  ): void {
    this.#state = harnessStateFromOmp(state, thinkingLevels, this.#permissionModeId);
    this.#event({ type: "session.state.changed", state: this.#state });
  }

  #invalidateUsage(): void {
    this.#usageGeneration += 1;
    if (this.#usage === null) return;
    this.#usage = null;
    this.#event({ type: "session.usage.changed", usage: null });
  }

  async #refreshUsage(observedForTurnId?: HostTurnId): Promise<void> {
    const transport = this.#transport;
    if (!transport || this.#phase !== "open") return;
    const generation = this.#usageGeneration;
    const refreshSequence = ++this.#usageRefreshSequence;
    const sessionId = transport.state.sessionId;
    const model = `${transport.state.provider ?? ""}\u0000${transport.state.modelId ?? ""}`;
    let usage: HostUsage | null;
    try {
      usage = await transport.getSessionUsage();
    } catch {
      return;
    }
    if (
      usage === null ||
      this.#phase !== "open" ||
      this.#transport !== transport ||
      this.#usageGeneration !== generation ||
      this.#usageRefreshSequence !== refreshSequence ||
      transport.state.sessionId !== sessionId ||
      `${transport.state.provider ?? ""}\u0000${transport.state.modelId ?? ""}` !== model
    ) {
      return;
    }
    if (JSON.stringify(usage) === JSON.stringify(this.#usage)) return;
    this.#usage = usage;
    this.#event({
      type: "session.usage.changed",
      usage,
      ...(observedForTurnId ? { observedForTurnId } : {}),
    });
  }

  #handleTurnEvent(active: ActiveTurn, event: OmpTurnEvent): void {
    if (this.#active !== active || this.#phase === "closed" || this.#phase === "faulted") return;
    switch (event.type) {
      case "text.delta":
        this.#activateAgentMessage(active, event.messageId);
        this.#appendText(active, event.delta);
        return;
      case "reasoning.delta":
        this.#activateAgentMessage(active, event.messageId);
        this.#appendReasoning(active, event.delta);
        return;
      case "reasoning.completed":
        this.#completeReasoning(active, { status: "succeeded" });
        return;
      case "message.completed":
        void this.#refreshUsage(active.command.turnId);
        return;
      case "compaction.started":
        this.#startCompaction(active);
        return;
      case "compaction.completed":
        this.#completeCompaction(active, event);
        return;
      case "interaction.requested":
        this.#startInteraction(active, event.request);
        return;
      case "interaction.closed":
        this.#closeInteraction(active, event.requestId, event.reason);
        return;
      case "tool.started":
        this.#completeReasoning(active, { status: "succeeded" });
        this.#completeAgentItem(active, { status: "succeeded" }, false);
        this.#startTool(active, event);
        return;
      case "tool.updated":
        this.#updateTool(active, event);
        return;
      case "tool.completed":
        this.#completeTool(active, event);
        return;
      case "subagent.started":
        {
          const subagent = active.subagents.start(active.command.turnId, event);
          this.#event({
            type: "subagent.state.changed",
            nativeSubagentId: subagent.nativeSubagentId ?? subagent.subagentId,
            status: subagent.status,
          });
        }
        return;
      case "subagent.updated":
        {
          const subagent = active.subagents.update(active.command.turnId, event);
          if (subagent) {
            this.#event({
              type: "subagent.state.changed",
              nativeSubagentId: subagent.nativeSubagentId ?? subagent.subagentId,
              status: subagent.status,
              ...(subagent.resultSummary ? { resultSummary: subagent.resultSummary } : {}),
            });
          }
        }
        return;
      case "subagent.completed":
        {
          const subagent = active.subagents.complete(
            active.command.turnId,
            event,
            active.cancellationRequested,
          );
          this.#event({
            type: "subagent.state.changed",
            nativeSubagentId: subagent.nativeSubagentId ?? subagent.subagentId,
            status: subagent.status,
            ...(subagent.resultSummary ? { resultSummary: subagent.resultSummary } : {}),
          });
        }
        return;
      case "subagent.transcript.changed":
        this.#event({
          type: "subagent.transcript.changed",
          nativeSubagentId: event.nativeSubagentId,
        });
    }
  }

  #startInteraction(active: ActiveTurn, request: OmpInteractionRequest): void {
    if (active.interactionByNativeId.has(request.requestId)) {
      throw new Error("Omp Interaction started more than once");
    }
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    let interaction: HostApprovalInteraction | HostQuestionInteraction;
    if (
      request.method === "select" &&
      request.options.length === 2 &&
      request.options[0] === "Approve" &&
      request.options[1] === "Deny"
    ) {
      interaction = {
        type: "approval",
        interactionId,
        turnId: active.command.turnId,
        title: request.title,
        subject: { type: "nativeAction" },
        actions: [
          { id: "allow-once", label: "Approve", effect: "allowOnce" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
        ...(request.timeoutMs !== undefined
          ? { expiresAt: new Date(Date.now() + request.timeoutMs).toISOString() }
          : {}),
      };
    } else {
      const question =
        request.method === "select"
          ? {
              id: "answer",
              type: "choice" as const,
              prompt: request.title,
              options: request.options.map((option) => ({ value: option, label: option })),
              multiple: false,
              allowOther: false,
              optional: false,
            }
          : request.method === "confirm"
            ? {
                id: "answer",
                type: "choice" as const,
                prompt: request.message || request.title,
                options: [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ],
                multiple: false,
                allowOther: false,
                optional: false,
              }
            : {
                id: "answer",
                type: "text" as const,
                prompt: request.title,
                multiline: request.method === "editor",
                secret: false,
                optional: false,
                ...(request.method === "input" && request.placeholder
                  ? { placeholder: request.placeholder }
                  : {}),
                ...(request.method === "editor" && request.prefill
                  ? { prefill: request.prefill }
                  : {}),
              };
      const associatedTool = active.tools.size === 1 ? [...active.tools.values()][0] : undefined;
      interaction = {
        type: "question",
        interactionId,
        turnId: active.command.turnId,
        ...(associatedTool ? { itemId: associatedTool.item.itemId } : {}),
        title: "OMP",
        questions: [question],
        ...(request.timeoutMs !== undefined
          ? { expiresAt: new Date(Date.now() + request.timeoutMs).toISOString() }
          : {}),
      };
    }
    active.interactions.set(interactionId, { interaction, nativeRequest: request });
    active.interactionByNativeId.set(request.requestId, interactionId);
    this.#channel.emit({ kind: "interaction", interaction });
  }

  #closeInteraction(
    active: ActiveTurn,
    nativeRequestId: string,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    const interactionId = active.interactionByNativeId.get(nativeRequestId);
    if (!interactionId) throw new Error("Omp Interaction close references an unknown request");
    active.interactionByNativeId.delete(nativeRequestId);
    active.interactions.delete(interactionId);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #startCompaction(active: ActiveTurn): void {
    if (active.compactionItem) throw new Error("Omp Compaction started more than once");
    const item: HostContextCompactionItem = {
      type: "contextCompaction",
      itemId: this.#newItemId(),
    };
    active.compactionItem = item;
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #completeCompaction(
    active: ActiveTurn,
    event: Extract<OmpTurnEvent, { type: "compaction.completed" }>,
  ): void {
    const item = active.compactionItem;
    if (!item) throw new Error("Omp Compaction completed without starting");
    active.compactionItem = null;
    const outcome: HostItemOutcome =
      event.outcome === "succeeded"
        ? { status: "succeeded" }
        : event.outcome === "cancelled"
          ? { status: "cancelled", reason: "Context compaction was cancelled" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: event.errorMessage ?? "Omp context compaction failed",
                retryable: true,
              },
            };
    this.#completeItem(active, item, outcome);
    if (event.outcome === "succeeded") void this.#refreshUsage(active.command.turnId);
  }

  #activateAgentMessage(active: ActiveTurn, messageId: string): void {
    if (active.agentMessageId === messageId) return;
    if (active.agentMessageId !== null) {
      this.#completeReasoning(active, { status: "succeeded" });
      this.#completeAgentItem(active, { status: "succeeded" }, false);
    }
    if (!active.agentItem) {
      active.agentItem = {
        type: "agentMessage",
        itemId: this.#newItemId(),
        text: "",
      };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: active.agentItem,
      });
    }
    active.agentMessageId = messageId;
    active.sawAssistantMessage = true;
  }

  #appendText(active: ActiveTurn, text: string): void {
    if (active.agentMessageId === null || !active.agentItem) {
      throw new Error("Omp Assistant text arrived outside an active message");
    }
    active.agentItem = { ...active.agentItem, text: active.agentItem.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeAgentItem(active: ActiveTurn, outcome: HostItemOutcome, completeEmpty: boolean): void {
    active.agentMessageId = null;
    const item = active.agentItem;
    if (!item || (!completeEmpty && item.text.length === 0)) return;
    active.agentItem = null;
    this.#completeItem(active, item, outcome);
  }

  #appendReasoning(active: ActiveTurn, text: string): void {
    if (text.length === 0) return;
    if (!active.reasoningItem) {
      active.reasoningItem = {
        type: "reasoning",
        itemId: this.#newItemId(),
        text: "",
      };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: active.reasoningItem,
      });
    }
    active.reasoningItem = {
      ...active.reasoningItem,
      text: active.reasoningItem.text + text,
    };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoningItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeReasoning(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.reasoningItem;
    if (!item) return;
    active.reasoningItem = null;
    this.#completeItem(active, item, outcome);
  }

  #startTool(active: ActiveTurn, event: Extract<OmpTurnEvent, { type: "tool.started" }>): void {
    if (active.tools.has(event.callId)) throw new Error("Omp Tool started more than once");
    const item = projectOmpToolItem({
      itemId: this.#newItemId(),
      toolName: event.toolName,
      arguments: event.arguments,
      cwd: stringField(event.arguments, "cwd") ?? this.#cwd,
    });
    active.tools.set(event.callId, {
      item,
      nativeName: event.toolName,
      arguments: event.arguments,
      startedAtMs: Date.now(),
    });
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #updateTool(active: ActiveTurn, event: Extract<OmpTurnEvent, { type: "tool.updated" }>): void {
    const tool = active.tools.get(event.callId);
    if (!tool) throw new Error("Omp Tool update references an unknown Tool Call");
    const output = boundedOutput(event.output, this.#toolOutputLimit);
    if (!output) return;
    const previous = tool.item.output ?? "";
    const next = outputText(output);
    tool.item = {
      ...tool.item,
      output: next,
      outputTruncated: output.truncated === true,
    };
    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      if (delta.length > 0) {
        this.#event({
          type: "item.updated",
          turnId: active.command.turnId,
          itemId: tool.item.itemId,
          update: { type: "output.append", text: delta },
        });
      }
    }
  }

  #completeTool(
    active: ActiveTurn,
    event: Extract<OmpTurnEvent, { type: "tool.completed" }>,
  ): void {
    const tool = active.tools.get(event.callId);
    if (!tool || tool.nativeName !== event.toolName) {
      throw new Error("Omp Tool completion references an unknown Tool Call");
    }
    active.tools.delete(event.callId);
    const durationMs = Math.max(0, Date.now() - tool.startedAtMs);
    const output = boundedOutput(event.result, this.#toolOutputLimit);
    const exitCode = numberField(event.result, "exitCode");
    tool.item = {
      ...tool.item,
      ...(output
        ? {
            output: outputText(output),
            outputTruncated: output.truncated === true,
          }
        : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      durationMs,
    };
    const outcome: HostItemOutcome = active.cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : event.isError
        ? { status: "failed", error: toolFailure(event.toolName) }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);

    if (!event.isError) {
      try {
        const kind = fileMutatingKind(event.toolName);
        const args = tool.arguments;
        if (kind && synthesizeFileChange(kind, args, this.#cwd)) {
          return;
        }
        const changes = reliableFileChange(event.toolName, args, event.result, this.#cwd);
        if (changes) {
          const fileItem: HostItem = { type: "fileChange", itemId: this.#newItemId(), changes };
          this.#event({ type: "item.started", turnId: active.command.turnId, item: fileItem });
          this.#completeItem(active, fileItem, { status: "succeeded" });
        }
      } catch {
        // Native Edit/Write results are often numbered snippets, not unified diffs.
        // Never let file-change projection fault the live Session.
      }
    }
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  async #completedTurnIdentity(
    active: ActiveTurn,
    transport: OmpTurnTransport,
  ): Promise<{ nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef }> {
    const snapshot = mapOmpSnapshot(await transport.getEntries(), {
      sessionId: transport.state.sessionId,
      model: nativeModelForHistory(transport.state),
    });
    const created = snapshot.turns.filter(
      (turn) => !active.beforeNativeTurnKeys.has(turn.nativeTurnRef.nativeTurnKey),
    );
    if (created.length !== 1) {
      throw new Error(
        `Omp Turn persisted ${created.length} new User Entries; exactly one is required`,
      );
    }
    const turn = created[0];
    if (!turn?.checkpoint) throw new Error("Omp Turn has no terminal Checkpoint identity");
    return { nativeTurnRef: turn.nativeTurnRef, checkpoint: turn.checkpoint };
  }

  #completeTurn(
    active: ActiveTurn,
    outcome: TurnOutcome,
    finalText?: string,
    nativeTurnRef?: NativeTurnRef,
  ): void {
    if (this.#active !== active) return;
    this.#active = null;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    this.#completeReasoning(active, itemOutcome);
    if (active.compactionItem) {
      this.#completeItem(active, active.compactionItem, itemOutcome);
      active.compactionItem = null;
    }
    for (const interactionId of active.interactions.keys()) {
      this.#event({
        type: "interaction.closed",
        interactionId,
        turnId: active.command.turnId,
        reason: outcome.status === "cancelled" ? "cancelled" : "superseded",
      });
    }
    active.interactions.clear();
    active.interactionByNativeId.clear();
    for (const tool of active.tools.values()) this.#completeItem(active, tool.item, itemOutcome);
    active.tools.clear();
    active.subagents.finalize(active.command.turnId, itemOutcome);
    if (!active.sawAssistantMessage && finalText !== undefined && active.agentItem) {
      active.agentItem = { ...active.agentItem, text: finalText };
    }
    this.#completeAgentItem(active, itemOutcome, true);
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
    active.resolveCompletion();
    queueMicrotask(() => {
      if (this.#phase === "open") void this.#refreshUsage(active.command.turnId);
    });
  }

  #fault(error: unknown): void {
    if (this.#phase === "closed" || this.#phase === "faulted") return;
    const normalized = normalizedError(error, "internalError");
    if (this.#active) {
      this.#completeTurn(this.#active, { status: "failed", error: normalized });
    }
    this.#phase = "faulted";
    this.#event({ type: "session.faulted", error: normalized });
    this.#channel.end();
  }

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    const wasFaulted = this.#phase === "faulted";
    if (!wasFaulted) this.#phase = "closing";
    const transport =
      this.#transport ?? (this.#starting ? await this.#starting.catch(() => null) : null);
    const active = this.#active;
    if (transport && active) {
      active.cancellationRequested = true;
      await transport.abort().catch(() => undefined);
      await Promise.race([active.completion, delay(this.#closeTimeoutMs)]);
    }
    try {
      if (transport) await transport.close();
    } catch (error) {
      this.#fault(error);
      throw error;
    }
    if (this.#active) {
      const error = invalidState("Omp Session closed before active Turn cancellation settled");
      this.#completeTurn(this.#active, { status: "failed", error });
    }
    if (!wasFaulted) {
      this.#phase = "closed";
      this.#channel.end();
    }
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}

export class OmpAdapter implements HarnessAdapter {
  readonly commandCatalog = ompCommandCatalog;
  readonly harnessId: HarnessId = ompHarnessId;
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async (input) => {
      if (
        input.parent.harnessId !== this.harnessId ||
        input.nativeSubagentId.trim().length === 0 ||
        input.cwd.length === 0
      ) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Omp Subagent reference is invalid",
            retryable: false,
          },
        };
      }
      let transport: OmpTurnTransport | undefined;
      try {
        transport = this.#createTransport({
          cwd: input.cwd,
          sessionFile: sessionFileFromRef(input.parent),
          onFault: () => undefined,
        });
        await transport.start();
        const transcript = await transport.getSubagentMessages({
          subagentId: input.nativeSubagentId,
        });
        const entries = transcript.entries;
        const leafId = entries.at(-1)?.id;
        const snapshot = mapOmpSnapshot(
          { entries, leafId: typeof leafId === "string" ? leafId : null },
          {
            sessionId: input.parent.nativeSessionId,
            model: nativeModelFromState(transport.state),
          },
        );
        return { ok: true, value: snapshot };
      } catch (error) {
        return { ok: false, error: normalizedError(error, "protocolError") };
      } finally {
        await transport?.close().catch(() => undefined);
      }
    },
  };
  readonly #closeTimeoutMs: number;
  readonly #createTransport: OmpAdapterDependencies["createTransport"];
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #inspections = new Set<OmpTurnTransport>();
  readonly #sessions = new Set<OmpHarnessSession>();
  readonly #toolOutputLimit: number;
  #closePromise: Promise<void> | null = null;
  #thinkingSelectionSupported: boolean | null = null;

  constructor(
    options: OmpAdapterOptions = {},
    dependencies: OmpAdapterDependencies = {
      createTransport: (sessionOptions) => new OmpRpcSession({ ...options, ...sessionOptions }),
    },
  ) {
    this.#createTransport = dependencies.createTransport;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: {
          code: "invalidState",
          message: "Omp Adapter is closed",
          retryable: false,
        },
      };
    }
    const cwd = input.cwd ?? process.cwd();
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }

    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const startedAt = Date.now();
    let stage = "spawn";
    const transport = this.#createTransport({ cwd, onFault: () => undefined });
    this.#inspections.add(transport);
    try {
      stage = "startup";
      await transport.start();
      stage = "model-catalog";
      const models = await transport.getAvailableModels();
      stage = "capabilities";
      const thinkingLevels = await transport.getAvailableThinkingLevels();
      this.#thinkingSelectionSupported = thinkingLevels !== null;
      const catalog = normalizeOmpModelCatalog(
        models,
        nativeModelFromState(transport.state),
        thinkingLevels,
        transport.state.thinkingLevel,
      );
      await transport.close();
      return {
        status: "ready",
        catalog,
        permissionModes: OMP_PERMISSION_MODE_CATALOG,
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: thinkingLevels !== null,
            selectPermissionMode: true,
            permissionModeScope: "live",
          },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
          subagents: { observe: true, readTranscript: true },
        },
      };
    } catch (error) {
      await transport.close().catch(() => undefined);
      const normalized = normalizedError(error, "unavailable");
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: {
          ...normalized,
          stage,
          durationMs: Date.now() - startedAt,
          ...(normalized.stderrTail || !transport.stderrTail
            ? {}
            : { stderrTail: transport.stderrTail }),
        },
      };
    } finally {
      this.#inspections.delete(transport);
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) {
      return { ok: false, error: invalidState("Omp Adapter is closed") };
    }
    if (input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Omp Adapter requires cwd",
          retryable: false,
        },
      };
    }
    if (input.kind === "create") {
      let permissionModeId =
        input.permissionModeId ??
        (input.executionPolicy === "unattended-full-access"
          ? encodeOmpPermissionModeId("yolo")
          : OMP_DEFAULT_PERMISSION_MODE_ID);
      let permissionMode: OmpPermissionMode;
      try {
        permissionModeId = harnessPermissionModeIdSchema.parse(permissionModeId);
        permissionMode = decodeOmpPermissionModeId(permissionModeId);
      } catch (error) {
        return { ok: false, error: normalizedError(error, "invalidRequest") };
      }
      if (input.model) {
        try {
          decodeOmpModelRef(input.model);
        } catch (error) {
          return { ok: false, error: normalizedError(error, "invalidRequest") };
        }
      }
      const thinkingOptionId = input.thinkingOptionId
        ? harnessThinkingOptionIdSchema.safeParse(input.thinkingOptionId)
        : null;
      if (thinkingOptionId && !thinkingOptionId.success) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Omp create Thinking option is invalid",
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: this.#trackSession(input.cwd, {
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(thinkingOptionId?.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
          supportsThinkingSelection: this.#thinkingSelectionSupported === true,
          permissionMode,
          permissionModeId,
        }),
      };
    }

    const sourceRef = nativeSessionRefSchema.parse(
      input.kind === "resume" ? input.nativeRef : input.sourceRef,
    ) as NativeSessionRef;
    let session: OmpHarnessSession | undefined;
    let transport: OmpTurnTransport | undefined;
    try {
      if (sourceRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Omp Adapter cannot open another Harness's Native Session",
            retryable: false,
          },
        };
      }
      const sourceSessionFile = sessionFileFromRef(sourceRef);
      if (input.kind === "fork") {
        const checkpoint = nativeCheckpointRefSchema.parse(input.checkpoint);
        if (
          checkpoint.harnessId !== this.harnessId ||
          checkpoint.nativeSessionId !== sourceRef.nativeSessionId
        ) {
          throw new OmpAdapterFaultError({
            code: "checkpointNotFound",
            message: "Omp Checkpoint does not belong to the source Native Session",
            retryable: false,
          });
        }
      }
      transport = this.#createTransport({
        cwd: input.cwd,
        ...(input.kind === "resume"
          ? { sessionFile: sourceSessionFile }
          : { forkSessionFile: sourceSessionFile }),
        onFault: (error) => session?.handleTransportFault(error),
        onSubagentEvent: (event) => session?.handleTransportEvent(event),
      });
      await transport.start();

      if (input.kind === "resume") {
        if (transport.state.sessionId !== sourceRef.nativeSessionId) {
          throw new OmpAdapterFaultError({
            code: "sessionNotFound",
            message: "Omp resumed Session identity does not match the persisted Native Session Ref",
            retryable: false,
          });
        }
      } else if (input.kind === "fork") {
        const checkpoint = nativeCheckpointRefSchema.parse(input.checkpoint);
        const startupSessionId = transport.state.sessionId;
        if (startupSessionId === sourceRef.nativeSessionId) {
          throw new Error("Omp Fork startup did not create a distinct Native Session identity");
        }
        const copiedHistory = await transport.getEntries();
        let boundary: ReturnType<typeof resolveOmpForkBoundary>;
        try {
          boundary = resolveOmpForkBoundary(copiedHistory, checkpoint.checkpointId);
        } catch {
          throw new OmpAdapterFaultError({
            code: "checkpointNotFound",
            message: "Omp Checkpoint is not on the source Session's active branch",
            retryable: false,
          });
        }
        const derivedState = boundary.nextUserEntryId
          ? await transport.fork(boundary.nextUserEntryId)
          : transport.state;
        if (
          derivedState.sessionId === sourceRef.nativeSessionId ||
          (boundary.nextUserEntryId && derivedState.sessionId === startupSessionId)
        ) {
          throw new Error("Omp Fork did not create the required Native Session identity");
        }
        const derivedSnapshot = mapOmpSnapshot(await transport.getEntries(), {
          sessionId: derivedState.sessionId,
          model: nativeModelForHistory(derivedState),
        });
        const terminal = derivedSnapshot.turns.at(-1);
        if (
          derivedSnapshot.turns.length !== boundary.targetTurnIndex + 1 ||
          terminal?.nativeTurnRef.nativeTurnKey !== checkpoint.checkpointId
        ) {
          throw new Error("Omp Fork derived history does not match the requested Checkpoint");
        }
        await transport.verifySessionCwd(input.cwd);
      } else {
        const rolledBack = await rollbackOmpLastTurn(
          transport,
          sourceRef.nativeSessionId,
          input.cwd,
        );
        if (!rolledBack.ok) {
          throw new OmpAdapterFaultError({
            code: "invalidState",
            message: "Omp Native Session has no Turn to roll back",
            retryable: false,
          });
        }
      }

      let startedThinkingLevels = await transport.getAvailableThinkingLevels();
      const reconciled = await reconcileThinkingLevel(
        transport,
        transport.state,
        startedThinkingLevels,
      );
      startedThinkingLevels = reconciled.thinkingLevels;
      this.#thinkingSelectionSupported = startedThinkingLevels !== null;
      const initialUsage = await transport.getSessionUsage().catch(() => null);
      session = this.#trackSession(input.cwd, {
        ...(input.environment ? { environment: input.environment } : {}),
        startedTransport: transport,
        startedThinkingLevels,
        initialUsage,
        supportsThinkingSelection: startedThinkingLevels !== null,
        permissionMode: "yolo",
        permissionModeId: OMP_DEFAULT_PERMISSION_MODE_ID,
      });
      return { ok: true, value: session };
    } catch (error) {
      await transport?.close().catch(() => undefined);
      return { ok: false, error: normalizedError(error, "nativeFailure") };
    }
  }

  #trackSession(
    cwd: string,
    options: {
      environment?: NodeJS.ProcessEnv;
      model?: HarnessModelRef;
      thinkingOptionId?: HarnessThinkingOptionId;
      supportsThinkingSelection: boolean;
      permissionMode: OmpPermissionMode;
      permissionModeId: HarnessPermissionModeId;
      startedTransport?: OmpTurnTransport;
      startedThinkingLevels?: HarnessThinkingOptionId[] | null;
      initialUsage?: HostUsage | null;
    },
  ): OmpHarnessSession {
    const environment = options.environment;
    const createTransport = environment
      ? (input: OmpRpcSessionOptions) => this.#createTransport({ ...input, environment })
      : this.#createTransport;
    const session = new OmpHarnessSession(
      cwd,
      createTransport,
      () => {
        this.#sessions.delete(session);
      },
      {
        closeTimeoutMs: this.#closeTimeoutMs,
        ...(options.model ? { model: options.model } : {}),
        ...(options.thinkingOptionId ? { thinkingOptionId: options.thinkingOptionId } : {}),
        toolOutputLimit: this.#toolOutputLimit,
        supportsThinkingSelection: options.supportsThinkingSelection,
        permissionMode: options.permissionMode,
        permissionModeId: options.permissionModeId,
        ...(options.startedTransport ? { startedTransport: options.startedTransport } : {}),
        ...(options.startedThinkingLevels !== undefined
          ? { startedThinkingLevels: options.startedThinkingLevels }
          : {}),
        ...(options.initialUsage !== undefined ? { initialUsage: options.initialUsage } : {}),
      },
    );
    this.#sessions.add(session);
    return session;
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = Promise.all([
        ...[...this.#inspections].map((transport) => transport.close()),
        ...[...this.#sessions].map((session) => session.close()),
      ]).then(() => undefined);
    }
    return this.#closePromise;
  }
}
