/**
 * Harness Session for OmO's classic stdio RPC transport.
 *
 * One `OmoRpcSession` (omo-rpc-session.ts) owns the native process, command
 * correlation, and the raw event stream; this module owns the Host contract on
 * top of it: the single ordered output stream, Turn lifecycle, Item projection,
 * Interaction bridging, cancellation, history snapshots, and close.
 *
 * Turn lifecycle rules this module enforces:
 *
 * - `turn.start` acceptance is not completion. The native `prompt` response
 *   only reports admission (`disposition`); the lifecycle flows through events.
 *   A rejected `prompt` emits no Turn events at all.
 * - `turn.started` is published when the engine admits the prompt, before its
 *   events are dispatched, so no Item can precede its Turn.
 * - `turn.completed` is published only on `agent_settled`. `agent_end` may be
 *   followed by an automatic retry, a compaction retry, or queued continuation,
 *   so it never completes a Turn.
 * - Exactly one terminal per accepted Turn. Events that carry another Turn's
 *   `clientTurnId` (OmO stamps it on the prompt, message, tool, and agent_end
 *   records) are dropped instead of being attributed to the running Turn, so a
 *   late aborted-run frame never pollutes the next Turn.
 * - The success identity is `omoHistoryTurnKey(<user-message entry id>)`
 *   (omo-history.ts), the only Turn identity OmO persists. The entry id comes
 *   from the `entry_appended` stream of the running Turn; when that stream does
 *   not carry the user message, a bounded `get_entries` fallback reads the
 *   entries appended after the Turn's pre-prompt cursor.
 *
 * Cancellation:
 *
 * - `turn.cancel` sends `abort {clearQueue: true}` without `awaitIdle`: the
 *   answer only acknowledges dispatch and may report `idle: false`, so it must
 *   not hold `execute`. The cancelled terminal is published after the aborted
 *   run's `agent_settled`.
 * - When the abort command itself fails, or no settle arrives within
 *   `cancelSettleTimeoutMs`, a bounded `get_state` probe decides whether the
 *   engine confirmed idle (then the Turn is settled as cancelled from native
 *   idleness) or is still streaming (then the Session faults, and the Host
 *   resumes instead of waiting forever).
 *
 * Interactions:
 *
 * - OmO raises `extension_ui_request` dialogs; the permission `select` maps to
 *   an Approval, every other dialog to a Question (see omo-interactions.ts).
 *   The adapter never announces OmO's `question` capability, so the engine
 *   uses its sequential fallback and this module never sees that method.
 * - Every Interaction closes exactly once (`responded`, `cancelled`, `expired`,
 *   `superseded`) through one path, including Turn cancel, Turn fault, Session
 *   fault, and close.
 * - A dialog with a native timeout also expires host-side, so a Turn whose
 *   question nobody answers cannot deadlock. The native side resolves on its own
 *   timer; the host emits `interaction.closed { reason: "expired" }`.
 * - Dialogs present in `get_state.pendingDialogs` when the Session opens belong
 *   to an interrupted run with no live Turn: they are cancelled natively so the
 *   engine is not left waiting on a card the Host cannot present.
 *
 * Faults: `transcript_write_failed` and `session_recovered` are not recoverable
 * by this layer (identity or content was already lost), so each faults the
 * Session after closing Interactions and terminating the active Turn. A
 * transport fault from omo-rpc-session.ts is reported the same way.
 *
 * Output bounds: tool output text is capped at `toolOutputLimit` (default 64k
 * characters) and a truncated diff is marked `diffScope: "fragment"`, matching
 * the public Item contract. Image parts pass through as base64 data.
 *
 * Calibration points left for the real-binary trace step (see
 * .omo/evidence/task-8-add-omo-harness.md): the live tool-result `details`
 * fields that carry an edit diff (`diff`/`patch`/`unifiedDiff`) and a shell
 * exit code (`details.exitCode`/`result.exitCode`), and the shell tool-name set.
 * Until a real trace confirms them, these are best-effort and a value that does
 * not match simply produces no `fileChange` Item and no exit code — never a
 * fault.
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import {
  HarnessOutputChannel,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostContextCompactionItem,
  type HostEvent,
  type HostFileChange,
  type HostFileChangeItem,
  type HostItem,
  type HostItemOutcome,
  type HostMcpToolCallItem,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostToolOutput,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCompleted,
  type ModelSelectCommand,
  type PermissionModeSelectCompleted,
  type PermissionModeSelectCommand,
  type ThinkingSelectCompleted,
  type ThinkingSelectCommand,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
  type TurnSteerAccepted,
  type TurnSteerCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HostInteractionId,
  type HostItemId,
  type JsonValue,
  type NativeCheckpointRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  selectOmoModel,
  selectOmoPermissionMode,
  selectOmoThinking,
  type OmoConfigurationChannel,
  type OmoConfigurationState,
} from "./omo-configuration.js";
import {
  omoHistoryTurnKey,
  readOmoSnapshot,
  OmoHistoryProtocolError,
  type OmoHistoryChannel,
} from "./omo-history.js";
import {
  answerOmoInteraction,
  omoInteractionResponseFrame,
  planOmoInteraction,
  readOmoDialogRequest,
  type OmoInteractionPlan,
} from "./omo-interactions.js";
import type { OmoEventFrame } from "./omo-protocol.js";
import {
  OmoRpcClosedError,
  OmoRpcCommandTimeoutError,
  OmoRpcFaultError,
  OmoRpcResponseError,
  type OmoRpcSession,
  type OmoRpcSessionState,
} from "./omo-rpc-session.js";

const omoHarnessId: HarnessId = harnessIdSchema.parse("omo");

/**
 * Capabilities of this build. Model, Thinking, and Permission Mode selection
 * are live (omO presets apply from the next permission decision, including
 * mid-Turn). History derivation and steering are not announced yet; they
 * arrive with their own steps.
 */
export const OMO_SESSION_CAPABILITIES: HarnessSessionCapabilities = Object.freeze({
  configuration: Object.freeze({
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live" as const,
  }),
  history: Object.freeze({ fork: false, forkAcrossCwd: false, rollbackLastTurn: false }),
  steer: false,
});

/** Tool output text retained per Item; larger output is truncated and marked. */
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
/** Budget for one abort command; `awaitIdle` is never requested, so this is generous. */
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
/** How long an accepted abort may wait for its run's `agent_settled` before probing. */
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 10_000;
/** Budget for one `get_state` idle probe during cancellation recovery. */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/** Grace for a native `agent_settled` after the probe proved the engine idle. */
const DEFAULT_SETTLE_GRACE_MS = 1_000;
/** Budget for one interaction answer, identity read, or dialog cancellation command. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/** How long close waits for a cancelled Turn to settle before completing it itself. */
const DEFAULT_CLOSE_TURN_TIMEOUT_MS = 2_000;
/** Entries per `get_entries` page used by the identity fallback. */
const IDENTITY_PAGE_LIMIT = 200;
/** Serialized bytes per identity page (8 MiB, the documented paged default). */
const IDENTITY_PAGE_BYTES = 8 * 1024 * 1024;
/** Bounded walk: five 200-entry pages are far more than one unsteered Turn appends. */
const IDENTITY_MAX_PAGES = 5;
/** Bound on events buffered between prompt admission and Turn publication. */
const MAX_DEFERRED_FRAMES = 1_024;

// Real 5.1.83 routes shell commands through the `eval` tool (bash, powershell
// and grep run inside eval cells; task-9 trace), so it routes like a shell
// and its args carry the executed snippet in `code`.
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "exec", "terminal", "run", "eval"]);
const SHELL_COMMAND_KEYS: readonly string[] = [
  "command",
  "cmd",
  "script",
  "code",
  "commandLine",
  "command_line",
];
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "patch",
  "apply_patch",
]);

type SessionPhase = "open" | "closing" | "closed" | "faulted";

interface PendingInteraction {
  readonly plan: OmoInteractionPlan;
  readonly timer: NodeJS.Timeout | null;
  /** Set synchronously before the native answer is written; a second answer is refused. */
  answering: boolean;
}

interface ActiveTool {
  item: HostCommandExecutionItem | HostToolExecutionItem | HostMcpToolCallItem;
  readonly nativeName: string;
  readonly arguments: JsonValue;
  readonly startedAtMs: number;
  outputText: string;
}

interface AssistantSegment {
  agentItem: HostAgentMessageItem | null;
  reasoningItem: HostReasoningItem | null;
}

interface AssistantTerminal {
  readonly text: string;
  readonly thinking: string;
  readonly stopReason: string | null;
  readonly errorMessage: string | null;
  readonly providerDiagnostic: Record<string, unknown> | null;
}

interface ActiveTurn {
  readonly command: TurnStartCommand;
  readonly clientTurnId: string;
  readonly baseline: IdentityBaseline;
  userEntryId: string | null;
  segment: AssistantSegment | null;
  compactionItem: HostContextCompactionItem | null;
  readonly tools: Map<string, ActiveTool>;
  readonly toolItemsByCallId: Map<string, HostItemId>;
  readonly interactions: Map<HostInteractionId, PendingInteraction>;
  readonly interactionByNativeId: Map<string, HostInteractionId>;
  cancellationRequested: boolean;
  settling: boolean;
  aborted: boolean;
  abortSource: string | null;
  agentFailure: Record<string, unknown> | null;
  lastAssistant: AssistantTerminal | null;
  interruptedToolResult: boolean;
  cancelGuard: NodeJS.Timeout | null;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

type IdentityBaseline =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "empty" }
  | { readonly kind: "unknown" };

export interface OmoHarnessSessionOptions {
  /** The native-confirmed identity published by Adapter.open. */
  initialState: HarnessSessionState;
  /** Called once when the Session closes (Adapter bookkeeping). */
  onClosed?(session: OmoHarnessSession): void;
  toolOutputLimit?: number;
  abortTimeoutMs?: number;
  cancelSettleTimeoutMs?: number;
  probeTimeoutMs?: number;
  settleGraceMs?: number;
  commandTimeoutMs?: number;
  closeTurnTimeoutMs?: number;
  /**
   * Session file of a create-kind Session that has not accepted a Turn yet.
   * Real 5.1.83 keeps an empty session file when a no-conversation Session
   * closes (task-9 evidence), so this adapter removes it itself after the
   * engine process exits: a prewarm create→close leaves no orphan file.
   * Resume-kind Sessions never pass this, and any accepted Turn cancels it
   * (with-conversation Sessions must persist).
   */
  prewarmSessionFile?: string;
}

/** A Session-protocol violation this module detected; never used for native refusals. */
export class OmoSessionProtocolError extends Error {
  readonly code = "protocolError" as const;

  constructor(message: string) {
    super(message);
    this.name = "OmoSessionProtocolError";
  }
}

function invalidRequest(message: string): HarnessError {
  return { code: "invalidRequest", message, retryable: false };
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

function busy(message: string): HarnessError {
  return { code: "sessionBusy", message, retryable: true };
}

function nativeFailure(message: string, retryable = false): HarnessError {
  return { code: "nativeFailure", message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberField(value: unknown, key: string): number | null | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (field === null) return null;
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** The client Turn id OmO stamps on prompt, message, tool, and agent_end records. */
function frameTurnId(frame: OmoEventFrame): string | null {
  return nonEmptyString(frame.clientTurnId);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function contentThinking(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        isRecord(part) && part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking)
    .join("");
}

/** Accumulated native tool result or progress payload as bounded Host output. */
function boundedToolOutput(value: unknown, limit: number): HostToolOutput | undefined {
  const content = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.content)
      ? value.content
      : typeof value === "string"
        ? value
        : undefined;
  if (typeof content === "string") {
    if (content.length === 0) return undefined;
    const truncated = content.length > limit;
    return {
      content: [{ type: "text", text: truncated ? content.slice(0, limit) : content }],
      ...(truncated ? { truncated: true } : {}),
    };
  }
  if (!Array.isArray(content)) return undefined;
  let text = "";
  const images: HostToolOutput["content"] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
      continue;
    }
    if (
      part.type === "image" &&
      typeof part.mimeType === "string" &&
      typeof part.data === "string"
    ) {
      images.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
    }
  }
  const truncated = text.length > limit;
  const parts: HostToolOutput["content"] = [
    ...(text.length === 0
      ? []
      : [{ type: "text" as const, text: truncated ? text.slice(0, limit) : text }]),
    ...images,
  ];
  if (parts.length === 0) return undefined;
  return { content: parts, ...(truncated ? { truncated: true } : {}) };
}

function outputText(output: HostToolOutput | undefined): string {
  return (
    output?.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("") ?? ""
  );
}

function jsonValueOf(value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringField(value: JsonValue, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const source of [value, value.input, value.arguments]) {
    if (isRecord(source) && typeof source[key] === "string" && source[key].length > 0) {
      return source[key];
    }
  }
  return undefined;
}

/** Use the same shell argument aliases as the history projection. */
function shellCommand(
  toolName: string,
  arguments_: JsonValue,
): { command: string; cwd?: string } | null {
  if (!SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return null;
  const command = SHELL_COMMAND_KEYS.map((key) => stringField(arguments_, key)).find(
    (value) => value !== undefined,
  );
  if (!command) return null;
  const cwd = stringField(arguments_, "cwd");
  return { command, ...(cwd ? { cwd } : {}) };
}

/** `mcp__<server>__<tool>`; live events may recase the name, history keeps the spelling. */
function mcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (separator <= 0 || server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}

function toolFailure(toolName: string): HarnessError {
  return nativeFailure(`OmO Tool '${toolName}' failed`);
}

/** The synthetic tool result OmO writes for a call an interrupted run never finished. */
function interruptedDetails(value: unknown): boolean {
  return isRecord(value) && isRecord(value.details) && isRecord(value.details.interrupted);
}

function liveExitCode(result: unknown): number | null | undefined {
  // Calibration point: the live tool result's exit code location is confirmed
  // against a real trace; both documented-ish shapes are accepted.
  const direct = numberField(result, "exitCode");
  if (direct !== undefined) return direct;
  return isRecord(result) ? numberField(result.details, "exitCode") : undefined;
}

/**
 * Best-effort `fileChange` projection for a file-editing tool. The live native
 * result shape is a calibration point for the real-binary trace step; a missing
 * or unusable diff produces no Item instead of a guessed patch.
 */
function fileChangeFromToolResult(
  toolName: string,
  arguments_: JsonValue,
  result: unknown,
  limit: number,
): HostFileChange | null {
  if (!FILE_TOOL_NAMES.has(toolName.toLowerCase())) return null;
  const details = isRecord(result) && isRecord(result.details) ? result.details : null;
  const candidates = [
    details?.diff,
    details?.patch,
    details?.unifiedDiff,
    isRecord(result) ? result.diff : undefined,
    isRecord(result) ? result.patch : undefined,
  ];
  const diff = candidates.find(
    (value): value is string => typeof value === "string" && value.includes("@@"),
  );
  if (!diff) return null;
  const path =
    stringField(arguments_, "path") ??
    stringField(arguments_, "filePath") ??
    stringField(arguments_, "file") ??
    (typeof details?.path === "string" ? details.path : undefined);
  if (!path) return null;
  const kind: HostFileChange["kind"] = diff.includes("--- /dev/null")
    ? "add"
    : diff.includes("+++ /dev/null")
      ? "delete"
      : "update";
  const truncated = diff.length > limit;
  return {
    path,
    kind,
    unifiedDiff: truncated ? diff.slice(0, limit) : diff,
    ...(truncated ? { diffScope: "fragment" as const } : {}),
  };
}

/** Maps a native/transport failure into the public error, preserving auth and model guidance. */
function sessionError(error: unknown, rpc: OmoRpcSession): HarnessError {
  if (error instanceof OmoRpcFaultError) {
    const diagnostic = error.diagnostic ? { diagnostic: error.diagnostic } : {};
    if (error.kind === "notInstalled") {
      return { code: "notInstalled", message: error.message, retryable: false, ...diagnostic };
    }
    if (error.kind === "protocolError") {
      return { code: "protocolError", message: error.message, retryable: false, ...diagnostic };
    }
    if (error.kind === "processExited") {
      return { code: "processExited", message: error.message, retryable: true, ...diagnostic };
    }
    return { code: "unavailable", message: error.message, retryable: true, ...diagnostic };
  }
  if (error instanceof OmoRpcResponseError) {
    if (error.category === "busy") {
      return { code: "sessionBusy", message: error.message, retryable: true };
    }
    if (error.category === "authentication") {
      return { code: "authenticationRequired", message: error.message, retryable: false };
    }
    if (error.category === "configuration") {
      return { code: "configurationRequired", message: error.message, retryable: false };
    }
    return nativeFailure(error.message);
  }
  if (error instanceof OmoRpcCommandTimeoutError) {
    return { code: "unavailable", message: error.message, retryable: true };
  }
  if (error instanceof OmoRpcClosedError) {
    return invalidState(error.message);
  }
  if (error instanceof OmoHistoryProtocolError || error instanceof OmoSessionProtocolError) {
    return { code: "protocolError", message: error.message, retryable: false };
  }
  if (error instanceof HarnessSessionFault) return error.error;
  const stderrTail = rpc.stderrTail;
  return {
    code: "internalError",
    message: messageOf(error),
    retryable: false,
    ...(stderrTail.length > 0 ? { stderrTail } : {}),
  };
}

/** Carries an already-normalized fault (used to funnel every fault path through one method). */
class HarnessSessionFault extends Error {
  constructor(readonly error: HarnessError) {
    super(error.message);
    this.name = "HarnessSessionFault";
  }
}

export class OmoHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = omoHarnessId;
  readonly capabilities: HarnessSessionCapabilities = OMO_SESSION_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #rpc: OmoRpcSession;
  readonly #onClosed: ((session: OmoHarnessSession) => void) | undefined;
  readonly #toolOutputLimit: number;
  readonly #abortTimeoutMs: number;
  readonly #cancelSettleTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #settleGraceMs: number;
  readonly #commandTimeoutMs: number;
  readonly #closeTurnTimeoutMs: number;
  readonly #prewarmSessionFile: string | null;
  #state: HarnessSessionState;
  readonly #pump: Promise<void>;
  readonly #consumedUserEntryIds = new Set<string>();
  readonly #emittedTurnKeys = new Set<string>();
  #accepting: { readonly clientTurnId: string } | null = null;
  #active: ActiveTurn | null = null;
  #configuring = false;
  #deferredFrames: OmoEventFrame[] = [];
  #phase: SessionPhase = "open";
  #closePromise: Promise<void> | null = null;
  #turnAccepted = false;

  constructor(rpc: OmoRpcSession, options: OmoHarnessSessionOptions) {
    this.#rpc = rpc;
    this.#state = options.initialState;
    this.initialState = options.initialState;
    this.#onClosed = options.onClosed;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    this.#abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.#cancelSettleTimeoutMs = options.cancelSettleTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#closeTurnTimeoutMs = options.closeTurnTimeoutMs ?? DEFAULT_CLOSE_TURN_TIMEOUT_MS;
    this.#prewarmSessionFile = options.prewarmSessionFile ?? null;
    this.outputs = this.#channel.outputs;
    this.#pump = this.#runEventPump();
    this.#cancelOrphanDialogs();
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("OmO Session is not open") };
    }
    if (this.#active || this.#accepting) {
      return {
        ok: false,
        error: busy("OmO Session cannot read history while a Turn is active"),
      };
    }
    const sessionId =
      this.#state.nativeRef?.nativeSessionId ?? nonEmptyString(this.#rpc.state.sessionId);
    if (!sessionId) {
      return {
        ok: false,
        error: {
          code: "protocolError",
          message: "OmO Session has no persisted identity to read history with",
          retryable: false,
        },
      };
    }
    try {
      const snapshot = await readOmoSnapshot(this.#rpc as OmoHistoryChannel, {
        sessionId,
        model: this.#rpc.state.model,
      });
      return { ok: true, value: { ...snapshot, state: this.#state } };
    } catch (error) {
      return { ok: false, error: sessionError(error, this.#rpc) };
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
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
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#phase !== "open") {
      return { ok: false, error: invalidState("OmO Session is not open") };
    }
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
      case "turn.cancel":
        return this.#cancelTurn(command);
      case "interaction.respond":
        return this.#respondToInteraction(command);
      case "turn.steer":
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "OmO Turn steering is not available in this build",
            retryable: false,
          },
        };
      case "model.select":
        return this.#selectConfiguration((channel) =>
          selectOmoModel(channel, command.model, { timeoutMs: this.#commandTimeoutMs }),
        );
      case "thinking.select":
        return this.#selectConfiguration((channel) =>
          selectOmoThinking(channel, command.thinkingOptionId, {
            timeoutMs: this.#commandTimeoutMs,
          }),
        );
      case "permissionMode.select":
        return this.#selectConfiguration((channel) =>
          selectOmoPermissionMode(channel, command.permissionModeId, {
            timeoutMs: this.#commandTimeoutMs,
          }),
        );
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#close().finally(() => this.#onClosed?.(this));
    }
    return this.#closePromise;
  }

  // ------------------------------------------------------------------ selection

  /**
   * Runs one configuration selection and publishes `session.state.changed`
   * only after the flow confirmed it natively; a refusal leaves the state
   * untouched. Selections run while a Turn streams — the engine applies a
   * preset from the next permission decision and a model switch from the
   * next request — so only two selections at once are refused.
   */
  async #selectConfiguration(
    flow: (channel: OmoConfigurationChannel) => Promise<HarnessResult<OmoConfigurationState>>,
  ): Promise<HarnessResult<{ completed: true }>> {
    if (this.#configuring) {
      return {
        ok: false,
        error: busy("OmO Session is already running a configuration selection"),
      };
    }
    this.#configuring = true;
    try {
      const result = await flow(this.#rpc);
      if (!result.ok) return result;
      this.#state = {
        ...(this.#state.nativeRef === undefined ? {} : { nativeRef: this.#state.nativeRef }),
        ...result.value,
      };
      this.#event({ type: "session.state.changed", state: this.#state });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return { ok: false, error: sessionError(error, this.#rpc) };
    } finally {
      this.#configuring = false;
    }
  }

  // ---------------------------------------------------------------- turn start

  async #startTurn(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#accepting || this.#active) {
      return { ok: false, error: busy("OmO Session already has an active Turn") };
    }
    const inputs = Array.isArray(command.input) ? command.input : [];
    const text = inputs.map((input) => input.text).join("\n");
    if (text.trim().length === 0) {
      return { ok: false, error: invalidRequest("OmO text Turn must not be empty") };
    }
    this.#accepting = { clientTurnId: command.turnId };
    this.#deferredFrames = [];
    try {
      const baseline = await this.#readIdentityBaseline();
      if (this.#phase !== "open") {
        this.#deferredFrames = [];
        return { ok: false, error: invalidState("OmO Session is no longer open") };
      }
      let resolveCompletion = (): void => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const turn: ActiveTurn = {
        command,
        clientTurnId: command.turnId,
        baseline,
        userEntryId: null,
        segment: null,
        compactionItem: null,
        tools: new Map(),
        toolItemsByCallId: new Map(),
        interactions: new Map(),
        interactionByNativeId: new Map(),
        cancellationRequested: false,
        settling: false,
        aborted: false,
        abortSource: null,
        agentFailure: null,
        lastAssistant: null,
        interruptedToolResult: false,
        cancelGuard: null,
        completion,
        resolveCompletion,
      };
      let response: { readonly data?: unknown };
      try {
        response = await this.#rpc.send("prompt", {
          message: text,
          clientTurnId: command.turnId,
        });
      } catch (error) {
        this.#deferredFrames = [];
        return { ok: false, error: sessionError(error, this.#rpc) };
      }
      if (this.#phase !== "open") {
        this.#deferredFrames = [];
        return { ok: false, error: invalidState("OmO Session is no longer open") };
      }
      // A handled prompt (an extension command) finishes without a native Turn.
      if (readDisposition(response.data) === "handled") {
        this.#deferredFrames = [];
        this.#turnAccepted = true;
        this.#event({ type: "turn.started", turnId: command.turnId });
        this.#event({
          type: "turn.completed",
          turnId: command.turnId,
          ephemeral: true,
          outcome: { status: "succeeded" },
        });
        return { ok: true, value: { turnId: command.turnId } };
      }
      this.#active = turn;
      this.#turnAccepted = true;
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#accepting = null;
      const buffered = this.#deferredFrames;
      this.#deferredFrames = [];
      for (const frame of buffered) {
        try {
          this.#dispatchFrame(frame);
        } catch (error) {
          this.#fault(
            new HarnessSessionFault({
              code: "protocolError",
              message: `OmO event projection failed: ${messageOf(error)}`,
              retryable: false,
            }),
          );
          break;
        }
      }
      return { ok: true, value: { turnId: command.turnId } };
    } finally {
      this.#accepting = null;
    }
  }

  async #readIdentityBaseline(): Promise<IdentityBaseline> {
    try {
      const response = await this.#rpc.send(
        "get_entries",
        { tail: 1, maxBytes: 1_048_576 },
        { timeoutMs: this.#commandTimeoutMs },
      );
      const data = response.data;
      if (!isRecord(data) || !Array.isArray(data.entries)) return { kind: "unknown" };
      if (data.entries.length === 0) return { kind: "empty" };
      const last = data.entries.at(-1);
      const id = isRecord(last) ? nonEmptyString(last.id) : null;
      return id ? { kind: "entry", entryId: id } : { kind: "unknown" };
    } catch {
      // The fallback still has the event stream and the newest-entry walk.
      return { kind: "unknown" };
    }
  }

  // --------------------------------------------------------------- turn cancel

  async #cancelTurn(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: invalidState("OmO Turn Cancel must reference the active Turn"),
      };
    }
    if (active.settling) {
      return {
        ok: false,
        error: invalidState("OmO Turn finished native execution and is recording its completion"),
      };
    }
    if (active.cancellationRequested) {
      return { ok: true, value: { cancellationRequested: true } };
    }
    active.cancellationRequested = true;
    this.#closeAllInteractions(active, "cancelled");
    try {
      await this.#rpc.send("abort", { clearQueue: true }, { timeoutMs: this.#abortTimeoutMs });
    } catch (error) {
      // The abort was not written: cancellation is unconfirmed, so the Session
      // cannot honestly keep running. The recovery probe settles the Turn and
      // faults the Session when the engine still reports a stream.
      this.#armCancelGuard(active);
      const normalized = sessionError(error, this.#rpc);
      void this.#recoverCancellation(active, `abort failed: ${normalized.message}`);
      return { ok: false, error: normalized };
    }
    this.#armCancelGuard(active);
    return { ok: true, value: { cancellationRequested: true } };
  }

  #armCancelGuard(active: ActiveTurn): void {
    if (this.#active !== active) return;
    if (active.cancelGuard) clearTimeout(active.cancelGuard);
    active.cancelGuard = setTimeout(() => {
      active.cancelGuard = null;
      void this.#recoverCancellation(active, "agent_settled did not arrive");
    }, this.#cancelSettleTimeoutMs);
    active.cancelGuard.unref?.();
  }

  /**
   * Bounded cancellation recovery, mirroring Pi's probe pattern: prove native
   * idleness with `get_state`, settle the Turn from that proof after a short
   * grace for the native settle record, and fault when the engine still
   * streams — the Host then resumes instead of waiting on a dead run.
   */
  async #recoverCancellation(active: ActiveTurn, cause: string): Promise<void> {
    if (this.#active !== active || this.#phase !== "open") return;
    let state: OmoRpcSessionState | null = null;
    try {
      state = await this.#rpc.refreshState({ timeoutMs: this.#probeTimeoutMs });
    } catch {
      state = null;
    }
    if (this.#active !== active || this.#phase !== "open") return;
    if (state && !state.isStreaming && !state.isCompacting) {
      await delay(this.#settleGraceMs);
      if (this.#active !== active || this.#phase !== "open") return;
      // A native settle for this run may still arrive; with no active Turn it
      // is ignored (agent_settled carries no Turn id).
      this.#finishTurn(
        active,
        {
          status: "cancelled",
          reason: `OmO cancelled after native idle confirmation (${cause})`,
        },
        this.#nativeTurnRefFor(active),
      );
      return;
    }
    this.#fault(
      new HarnessSessionFault({
        code: "nativeFailure",
        message: `OmO cancellation could not be confirmed (${cause})`,
        retryable: true,
      }),
    );
  }

  // -------------------------------------------------------------- interactions

  async #respondToInteraction(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#active;
    const pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) {
      return {
        ok: false,
        error: invalidState("OmO Interaction Response must reference a pending Interaction"),
      };
    }
    if (pending.answering) {
      return {
        ok: false,
        error: invalidState("OmO Interaction already has an answer in flight"),
      };
    }
    const answered = answerOmoInteraction(pending.plan, command.response);
    if ("error" in answered) return { ok: false, error: answered.error };
    pending.answering = true;
    if (pending.timer) clearTimeout(pending.timer);
    try {
      await this.#rpc.send(
        "extension_ui_response",
        omoInteractionResponseFrame(pending.plan, answered.answer),
        { timeoutMs: this.#commandTimeoutMs },
      );
    } catch (error) {
      if (error instanceof OmoRpcCommandTimeoutError) {
        // The frame was written but its acknowledgement did not arrive. The
        // engine may have applied it; reporting a failure would invite a second
        // answer for the same dialog, so the Interaction closes as responded.
        this.#closeInteraction(active, command.interactionId, "responded");
        return { ok: true, value: { accepted: true } };
      }
      if (
        error instanceof OmoRpcResponseError &&
        (error.errorCode === "unknown_extension_ui_request" ||
          error.errorCode === "question_already_resolved")
      ) {
        this.#closeInteraction(active, command.interactionId, "expired");
        return {
          ok: false,
          error: {
            code: "invalidState",
            message: `OmO no longer holds the dialog: ${error.message}`,
            retryable: false,
          },
        };
      }
      this.#closeInteraction(active, command.interactionId, "cancelled");
      return { ok: false, error: sessionError(error, this.#rpc) };
    }
    this.#closeInteraction(active, command.interactionId, "responded");
    return { ok: true, value: { accepted: true } };
  }

  #handleDialogFrame(frame: OmoEventFrame, active: ActiveTurn | null): void {
    // The capability-gated `question` method is never announced (see
    // omo-rpc-session.ts), so the engine uses its sequential fallback. A
    // `question` frame that still arrives cannot be answered through this
    // contract; cancel it so the engine does not wait on it.
    if (frame.method === "question") {
      const id = nonEmptyString(frame.id);
      if (id) this.#cancelNativeDialog(id);
      return;
    }
    const request = readOmoDialogRequest(frame);
    if (!request) return;
    if (!active || active.settling || active.cancellationRequested) {
      // A dialog with no live Turn (an interrupted run's dialog, or one raised
      // after cancellation) cannot be presented; cancel it natively so the
      // engine stops waiting on it.
      this.#cancelNativeDialog(request.id);
      return;
    }
    if (active.interactionByNativeId.has(request.id)) return;
    const itemId = request.toolCallId
      ? active.toolItemsByCallId.get(request.toolCallId)
      : undefined;
    const plan = planOmoInteraction(request, {
      turnId: active.command.turnId,
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      ...(itemId === undefined ? {} : { itemId }),
      nowMs: Date.now(),
    });
    if (!plan) {
      this.#cancelNativeDialog(request.id);
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    if (request.timeoutMs !== null) {
      timer = setTimeout(() => {
        if (this.#active !== active) return;
        this.#closeInteraction(active, plan.interaction.interactionId, "expired");
      }, request.timeoutMs);
      timer.unref?.();
    }
    active.interactions.set(plan.interaction.interactionId, {
      plan,
      timer,
      answering: false,
    });
    active.interactionByNativeId.set(request.id, plan.interaction.interactionId);
    this.#channel.emit({ kind: "interaction", interaction: plan.interaction });
  }

  #cancelNativeDialog(nativeRequestId: string): void {
    if (this.#rpc.fault !== null) return;
    void this.#rpc
      .send(
        "extension_ui_response",
        { uiRequestId: nativeRequestId, cancelled: true },
        { timeoutMs: this.#commandTimeoutMs },
      )
      .catch(() => undefined);
  }

  /** The one path that closes an Interaction; a second call for the same id does nothing. */
  #closeInteraction(
    active: ActiveTurn,
    interactionId: HostInteractionId,
    reason: "responded" | "cancelled" | "expired" | "superseded",
  ): void {
    const pending = active.interactions.get(interactionId);
    if (!pending) return;
    active.interactions.delete(interactionId);
    active.interactionByNativeId.delete(pending.plan.nativeRequestId);
    if (pending.timer) clearTimeout(pending.timer);
    this.#event({
      type: "interaction.closed",
      interactionId,
      turnId: active.command.turnId,
      reason,
    });
  }

  #closeAllInteractions(active: ActiveTurn, reason: "cancelled" | "expired" | "superseded"): void {
    for (const interactionId of [...active.interactions.keys()]) {
      this.#closeInteraction(active, interactionId, reason);
    }
  }

  #cancelOrphanDialogs(): void {
    for (const dialog of this.#rpc.state.pendingDialogs) {
      const id = nonEmptyString(dialog.id);
      if (id) this.#cancelNativeDialog(id);
    }
  }

  // -------------------------------------------------------------- event pump

  async #runEventPump(): Promise<void> {
    try {
      for await (const frame of this.#rpc.events()) {
        if (this.#phase !== "open" && this.#phase !== "closing") continue;
        try {
          this.#handleFrame(frame);
        } catch (error) {
          this.#fault(
            new HarnessSessionFault({
              code: "protocolError",
              message: `OmO event projection failed: ${messageOf(error)}`,
              retryable: false,
            }),
          );
        }
      }
    } catch (error) {
      this.#fault(
        new HarnessSessionFault({
          code: "protocolError",
          message: `OmO event stream failed: ${messageOf(error)}`,
          retryable: false,
        }),
      );
      return;
    }
    if (this.#phase === "open" || this.#phase === "closing") {
      // The transport ends its stream on close and on fault. A fault is
      // reported through the Session; a stream that ends while this Session
      // still expects one is a process failure. Ending during our own close is
      // expected and never a fault.
      const fault = this.#rpc.fault;
      if (fault) {
        this.#fault(fault);
      } else if (this.#phase === "open") {
        this.#fault(
          new HarnessSessionFault({
            code: "processExited",
            message: "OmO event stream ended without a fault",
            retryable: true,
          }),
        );
      }
    }
  }

  #handleFrame(frame: OmoEventFrame): void {
    if (frame.type === "transcript_write_failed") {
      const role = nonEmptyString(frame.role) ?? "message";
      const detail = nonEmptyString(frame.errorMessage) ?? "the session file refused a write";
      this.#fault(
        new HarnessSessionFault({
          code: "nativeFailure",
          message: `OmO could not persist the ${role}: ${detail}`,
          retryable: false,
        }),
      );
      return;
    }
    if (frame.type === "session_recovered") {
      const cause = nonEmptyString(frame.cause) ?? "an incomplete record";
      this.#fault(
        new HarnessSessionFault({
          code: "protocolError",
          message: `OmO repaired an incomplete session record (${cause}); persisted history changed`,
          retryable: false,
        }),
      );
      return;
    }
    if (this.#accepting) {
      const turnId = frameTurnId(frame);
      if (turnId === null || turnId === this.#accepting.clientTurnId) {
        if (this.#deferredFrames.length >= MAX_DEFERRED_FRAMES) {
          throw new OmoSessionProtocolError(
            "OmO emitted too many events before admitting the prompt",
          );
        }
        this.#deferredFrames.push(frame);
        return;
      }
    }
    this.#dispatchFrame(frame);
  }

  #dispatchFrame(frame: OmoEventFrame): void {
    const turnId = frameTurnId(frame);
    const active = this.#active;
    if (active && turnId !== null && turnId !== active.clientTurnId) {
      // A frame for another Turn (including a late aborted-run frame) must never
      // touch the active Turn.
      return;
    }
    if (frame.type === "extension_ui_request") {
      this.#handleDialogFrame(frame, active);
      return;
    }
    if (!active || active.settling) return;
    switch (frame.type) {
      case "entry_appended":
        this.#handleEntryAppended(active, frame);
        return;
      case "message_start":
        if (isRecord(frame.message) && frame.message.role === "assistant") {
          this.#rotateSegment(active);
        }
        return;
      case "message_update":
        this.#handleMessageUpdate(active, frame);
        return;
      case "message_end":
        this.#handleMessageEnd(active, frame);
        return;
      case "tool_execution_start":
        this.#startTool(active, frame);
        return;
      case "tool_execution_update":
        this.#updateTool(active, frame);
        return;
      case "tool_execution_end":
        this.#completeTool(active, frame);
        return;
      case "compaction_start":
        this.#startCompaction(active);
        return;
      case "compaction_end":
        this.#completeCompaction(active, frame);
        return;
      case "agent_end":
        this.#handleAgentEnd(active, frame);
        return;
      case "agent_settled":
        this.#handleSettled(active);
        return;
      default:
        // Event types are additive; a record this client cannot project (retry,
        // queue, lifecycle, barrier, model notices, autonomous chatter) is kept
        // out of the Turn rather than faulted.
        return;
    }
  }

  #handleEntryAppended(active: ActiveTurn, frame: OmoEventFrame): void {
    const entry = frame.entry;
    if (!isRecord(entry)) return;
    const id = nonEmptyString(entry.id);
    if (entry.type !== "message" || !isRecord(entry.message)) return;
    const role = entry.message.role;
    if (role === "user" && id && active.userEntryId === null) {
      active.userEntryId = id;
      this.#consumedUserEntryIds.add(id);
      return;
    }
    if (role === "toolResult" && interruptedDetails(entry.message)) {
      active.interruptedToolResult = true;
    }
  }

  #handleMessageUpdate(active: ActiveTurn, frame: OmoEventFrame): void {
    const update = frame.assistantMessageEvent;
    if (!isRecord(update) || typeof update.type !== "string") return;
    switch (update.type) {
      case "text_delta":
        this.#appendAssistantText(active, typeof update.delta === "string" ? update.delta : "");
        return;
      case "thinking_delta":
        this.#appendReasoning(active, typeof update.delta === "string" ? update.delta : "");
        return;
      case "text_start":
      case "thinking_start":
        // A new content block inside the same assistant message keeps one Item
        // segment; message_end is the segment boundary.
        this.#segment(active);
        return;
      default:
        // toolcall_* deltas carry no Item of their own: tool_execution_start
        // reports the call and its arguments.
        return;
    }
  }

  #rotateSegment(active: ActiveTurn): void {
    const segment = active.segment;
    if (segment && (segment.agentItem || segment.reasoningItem)) {
      this.#completeSegment(active, null, null);
      return;
    }
    active.segment ??= { agentItem: null, reasoningItem: null };
  }

  #segment(active: ActiveTurn): AssistantSegment {
    active.segment ??= { agentItem: null, reasoningItem: null };
    return active.segment;
  }

  #appendAssistantText(active: ActiveTurn, delta: string): void {
    if (delta.length === 0) return;
    const segment = this.#segment(active);
    let item = segment.agentItem;
    if (!item) {
      item = { type: "agentMessage", itemId: this.#newItemId(), text: "" };
      segment.agentItem = item;
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    segment.agentItem = { ...item, text: item.text + delta };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  #appendReasoning(active: ActiveTurn, delta: string): void {
    if (delta.length === 0) return;
    const segment = this.#segment(active);
    let item = segment.reasoningItem;
    if (!item) {
      item = { type: "reasoning", itemId: this.#newItemId(), text: "" };
      segment.reasoningItem = item;
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    segment.reasoningItem = { ...item, text: item.text + delta };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: item.itemId,
      update: { type: "text.append", text: delta },
    });
  }

  /** Completes the open segment; authoritative native content wins over streamed text. */
  #completeSegment(
    active: ActiveTurn,
    authoritativeText: string | null,
    authoritativeThinking: string | null,
  ): void {
    const segment = active.segment;
    active.segment = null;
    if (!segment) return;
    if (segment.reasoningItem) {
      const text =
        authoritativeThinking !== null && authoritativeThinking.length > 0
          ? authoritativeThinking
          : segment.reasoningItem.text;
      this.#completeItem(active, { ...segment.reasoningItem, text }, { status: "succeeded" });
    }
    const text =
      authoritativeText !== null && authoritativeText.length > 0
        ? authoritativeText
        : (segment.agentItem?.text ?? "");
    if (segment.agentItem) {
      this.#completeItem(active, { ...segment.agentItem, text }, { status: "succeeded" });
    } else if (text.length > 0) {
      const item: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: this.#newItemId(),
        text,
      };
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
      this.#completeItem(active, item, { status: "succeeded" });
    }
  }

  #handleMessageEnd(active: ActiveTurn, frame: OmoEventFrame): void {
    const message = frame.message;
    if (!isRecord(message)) return;
    if (message.role === "toolResult") {
      if (interruptedDetails(message)) active.interruptedToolResult = true;
      return;
    }
    if (message.role !== "assistant") return;
    const stopReason = nonEmptyString(message.stopReason);
    const terminal: AssistantTerminal = {
      text: contentText(message.content),
      thinking: contentThinking(message.content),
      stopReason,
      errorMessage: nonEmptyString(message.errorMessage),
      providerDiagnostic: isRecord(message.providerDiagnostic) ? message.providerDiagnostic : null,
    };
    if (stopReason !== null && stopReason !== "pending") active.lastAssistant = terminal;
    this.#completeSegment(active, terminal.text, terminal.thinking);
  }

  #startTool(active: ActiveTurn, frame: OmoEventFrame): void {
    const callId = nonEmptyString(frame.toolCallId);
    const rawName = nonEmptyString(frame.toolName) ?? nonEmptyString(frame.resolvedToolName);
    if (!callId || !rawName) return;
    if (active.tools.has(callId)) return;
    // `resolvedToolName` is the tool the call will run; tool_execution_* already
    // recases it, so it is only a fallback here.
    const toolName = nonEmptyString(frame.resolvedToolName) ?? rawName;
    const arguments_ = jsonValueOf(frame.args);
    const shell = shellCommand(toolName, arguments_);
    const mcp = mcpToolName(toolName);
    const item: HostCommandExecutionItem | HostToolExecutionItem | HostMcpToolCallItem = shell
      ? {
          type: "commandExecution",
          itemId: this.#newItemId(),
          command: shell.command,
          ...(shell.cwd ? { cwd: shell.cwd } : {}),
        }
      : mcp
        ? {
            type: "mcpToolCall",
            itemId: this.#newItemId(),
            server: mcp.server,
            tool: mcp.tool,
            arguments: arguments_,
          }
        : {
            type: "toolExecution",
            itemId: this.#newItemId(),
            toolName,
            arguments: arguments_,
          };
    active.tools.set(callId, {
      item,
      nativeName: toolName,
      arguments: arguments_,
      startedAtMs: Date.now(),
      outputText: "",
    });
    active.toolItemsByCallId.set(callId, item.itemId);
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #updateTool(active: ActiveTurn, frame: OmoEventFrame): void {
    const callId = nonEmptyString(frame.toolCallId);
    const tool = callId ? active.tools.get(callId) : undefined;
    if (!tool) return;
    const output = boundedToolOutput(frame.partialResult, this.#toolOutputLimit);
    if (!output) return;
    if (tool.item.type === "commandExecution") {
      const next = outputText(output);
      const previous = tool.outputText;
      tool.outputText = next;
      tool.item = {
        ...tool.item,
        output: next,
        ...(output.truncated === true ? { outputTruncated: true } : {}),
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
        return;
      }
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: tool.item.itemId,
        update: { type: "output.replace", output },
      });
      return;
    }
    tool.item = { ...tool.item, output };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: tool.item.itemId,
      update: { type: "output.replace", output },
    });
  }

  #completeTool(active: ActiveTurn, frame: OmoEventFrame): void {
    const callId = nonEmptyString(frame.toolCallId);
    const tool = callId ? active.tools.get(callId) : undefined;
    if (!callId || !tool) return;
    active.tools.delete(callId);
    const durationMs = Math.max(0, Date.now() - tool.startedAtMs);
    const result = frame.result;
    const output = boundedToolOutput(result, this.#toolOutputLimit);
    const exitCode = liveExitCode(result);
    if (tool.item.type === "commandExecution") {
      tool.item = {
        ...tool.item,
        ...(output
          ? {
              output: outputText(output),
              ...(output.truncated === true ? { outputTruncated: true } : {}),
            }
          : {}),
        ...(exitCode === undefined ? {} : { exitCode }),
        durationMs,
      };
    } else {
      tool.item = { ...tool.item, ...(output ? { output } : {}), durationMs };
    }
    const outcome: HostItemOutcome = active.cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : frame.isError === true
        ? { status: "failed", error: toolFailure(tool.nativeName) }
        : { status: "succeeded" };
    this.#completeItem(active, tool.item, outcome);
    if (interruptedDetails(result)) active.interruptedToolResult = true;
    if (frame.isError !== true) {
      const change = fileChangeFromToolResult(
        tool.nativeName,
        tool.arguments,
        result,
        this.#toolOutputLimit,
      );
      if (change) {
        const item: HostFileChangeItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
          changes: [change],
          sourceItemIds: [tool.item.itemId],
        };
        this.#event({ type: "item.started", turnId: active.command.turnId, item });
        this.#completeItem(active, item, {
          status: active.cancellationRequested ? "cancelled" : "succeeded",
        });
      }
    }
  }

  #startCompaction(active: ActiveTurn): void {
    if (active.compactionItem) return;
    const item: HostContextCompactionItem = {
      type: "contextCompaction",
      itemId: this.#newItemId(),
    };
    active.compactionItem = item;
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #completeCompaction(active: ActiveTurn, frame: OmoEventFrame): void {
    const item = active.compactionItem;
    if (!item) return;
    active.compactionItem = null;
    const errorMessage = nonEmptyString(frame.errorMessage);
    const outcome: HostItemOutcome =
      frame.aborted === true
        ? { status: "cancelled", reason: "OmO context compaction was aborted" }
        : errorMessage
          ? { status: "failed", error: nativeFailure(errorMessage) }
          : { status: "succeeded" };
    this.#completeItem(active, item, outcome);
  }

  #handleAgentEnd(active: ActiveTurn, frame: OmoEventFrame): void {
    const messages = Array.isArray(frame.messages) ? frame.messages : [];
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (message.role === "toolResult" && interruptedDetails(message)) {
        active.interruptedToolResult = true;
      }
      if (message.role !== "assistant") continue;
      const stopReason = nonEmptyString(message.stopReason);
      if (stopReason === null || stopReason === "pending") continue;
      active.lastAssistant = {
        text: contentText(message.content),
        thinking: contentThinking(message.content),
        stopReason,
        errorMessage: nonEmptyString(message.errorMessage),
        providerDiagnostic: isRecord(message.providerDiagnostic)
          ? message.providerDiagnostic
          : null,
      };
    }
    if (frame.aborted === true) active.aborted = true;
    if (active.lastAssistant?.stopReason === "aborted") active.aborted = true;
    const abortSource = nonEmptyString(frame.abortSource);
    if (abortSource) active.abortSource = abortSource;
    if (isRecord(frame.failure)) active.agentFailure = frame.failure;
    // agent_end is never a terminal: a retry, a compaction retry, or a queued
    // continuation may still follow, and only agent_settled means "settled".
  }

  #handleSettled(active: ActiveTurn): void {
    if (this.#active !== active || active.settling) return;
    active.settling = true;
    void this.#settleTurn(active);
  }

  async #settleTurn(active: ActiveTurn): Promise<void> {
    let identity: { nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef } | null = null;
    let identityError: HarnessError | null = null;
    try {
      identity = await this.#turnIdentity(active);
    } catch (error) {
      identityError = sessionError(error, this.#rpc);
    }
    if (this.#active !== active) return;
    this.#finishTurn(
      active,
      this.#turnOutcome(active, identity, identityError),
      identity?.nativeTurnRef,
    );
  }

  /**
   * Resolves the Turn's persisted user-message entry id. The live
   * `entry_appended` stream is the primary source (OmO emits it right after the
   * persisted user message); the bounded `get_entries` walk covers an engine
   * that does not stream entry identity.
   */
  async #turnIdentity(
    active: ActiveTurn,
  ): Promise<{ nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef }> {
    const sessionId =
      this.#state.nativeRef?.nativeSessionId ?? nonEmptyString(this.#rpc.state.sessionId);
    if (!sessionId) {
      throw new OmoSessionProtocolError("OmO Turn has no persisted Session identity");
    }
    const userEntryId = active.userEntryId ?? (await this.#readUserEntryId(active));
    active.userEntryId = userEntryId;
    this.#consumedUserEntryIds.add(userEntryId);
    const nativeTurnKey = omoHistoryTurnKey(userEntryId);
    if (this.#emittedTurnKeys.has(nativeTurnKey)) {
      throw new OmoSessionProtocolError(
        `OmO persisted no new User Entry for this Turn (${nativeTurnKey} already ended a Turn)`,
      );
    }
    this.#emittedTurnKeys.add(nativeTurnKey);
    return {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: omoHarnessId,
        nativeSessionId: sessionId,
        nativeTurnKey,
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: omoHarnessId,
        nativeSessionId: sessionId,
        checkpointId: userEntryId,
        formatVersion: 1,
      }),
    };
  }

  async #readUserEntryId(active: ActiveTurn): Promise<string> {
    if (active.baseline.kind === "entry" || active.baseline.kind === "empty") {
      let since = active.baseline.kind === "entry" ? active.baseline.entryId : undefined;
      for (let page = 0; page < IDENTITY_MAX_PAGES; page += 1) {
        const response = await this.#rpc.send(
          "get_entries",
          {
            limit: IDENTITY_PAGE_LIMIT,
            maxBytes: IDENTITY_PAGE_BYTES,
            ...(since === undefined ? {} : { since }),
          },
          { timeoutMs: this.#identityReadTimeoutMs() },
        );
        const { entries, hasMore, next } = historyPage(response.data, "get_entries");
        for (const entry of entries) {
          const id = userMessageEntryId(entry);
          if (id) return id;
        }
        if (!hasMore) break;
        if (next === undefined || next === since) break;
        since = next;
      }
      throw new OmoSessionProtocolError("OmO history has no User Entry for the settled Turn");
    }
    // No usable pre-prompt cursor (a non-empty history whose tail read failed):
    // walk back from the newest entries and take the newest unseen user entry.
    let before: string | undefined;
    for (let page = 0; page < IDENTITY_MAX_PAGES; page += 1) {
      const response = await this.#rpc.send(
        "get_entries",
        {
          tail: IDENTITY_PAGE_LIMIT,
          maxBytes: IDENTITY_PAGE_BYTES,
          ...(before === undefined ? {} : { before }),
        },
        { timeoutMs: this.#identityReadTimeoutMs() },
      );
      const { entries, hasMore, next } = historyPage(response.data, "get_entries");
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const id = userMessageEntryId(entries[index]);
        if (id && !this.#consumedUserEntryIds.has(id)) return id;
      }
      if (!hasMore) break;
      if (next === undefined || next === before) break;
      before = next;
    }
    throw new OmoSessionProtocolError("OmO history has no new User Entry for the settled Turn");
  }

  #identityReadTimeoutMs(): number {
    return Math.max(this.#commandTimeoutMs, this.#probeTimeoutMs);
  }

  #turnOutcome(
    active: ActiveTurn,
    identity: { nativeTurnRef: NativeTurnRef; checkpoint: NativeCheckpointRef } | null,
    identityError: HarnessError | null,
  ): TurnOutcome {
    const checkpoint = identity?.checkpoint;
    const withCheckpoint = (outcome: TurnOutcome): TurnOutcome =>
      checkpoint === undefined ? outcome : { ...outcome, checkpoint };
    if (identityError) return withCheckpoint({ status: "failed", error: identityError });
    if (active.aborted) {
      return withCheckpoint({
        status: "cancelled",
        reason:
          active.abortSource === "user"
            ? "Cancelled by user"
            : active.abortSource === null
              ? "OmO run was aborted"
              : `OmO run was aborted (source: ${active.abortSource})`,
      });
    }
    const last = active.lastAssistant;
    if (last?.stopReason === "error" || active.agentFailure !== null) {
      return withCheckpoint({ status: "failed", error: this.#failureError(active) });
    }
    if (active.interruptedToolResult && (last === null || last.stopReason === "toolUse")) {
      // A restored interrupted run replays a synthetic failed tool result and
      // does not answer again on its own; presenting that as success would hide
      // lost work.
      return withCheckpoint({
        status: "cancelled",
        reason: "OmO restored an interrupted tool call",
      });
    }
    if (last === null) {
      return withCheckpoint({
        status: "failed",
        error: nativeFailure("OmO run settled without an assistant answer"),
      });
    }
    // stopReason "deferred" is terminal for this run and is projected as
    // succeeded by the history reader as well; keep both surfaces aligned.
    return withCheckpoint({ status: "succeeded" });
  }

  #failureError(active: ActiveTurn): HarnessError {
    const failure = active.agentFailure;
    const category = failure ? nonEmptyString(failure.category) : null;
    const message =
      (failure ? nonEmptyString(failure.reason) : null) ??
      active.lastAssistant?.errorMessage ??
      "OmO run failed";
    if (category === "auth" || active.lastAssistant?.providerDiagnostic?.category === "auth") {
      return { code: "authenticationRequired", message, retryable: false };
    }
    return nativeFailure(message);
  }

  #finishTurn(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (this.#active !== active) return;
    this.#active = null;
    if (active.cancelGuard) {
      clearTimeout(active.cancelGuard);
      active.cancelGuard = null;
    }
    this.#closeAllInteractions(active, outcome.status === "succeeded" ? "superseded" : "cancelled");
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    this.#completeSegment(active, null, null);
    if (active.compactionItem) {
      this.#completeItem(active, active.compactionItem, itemOutcome);
      active.compactionItem = null;
    }
    for (const tool of active.tools.values()) {
      this.#completeItem(active, tool.item, itemOutcome);
    }
    active.tools.clear();
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef === undefined ? {} : { nativeTurnRef }),
    });
    active.resolveCompletion();
  }

  /**
   * The native Turn ref for a settled Turn: resolved identity when available,
   * otherwise the persisted user entry recorded during the run. A Turn that
   * persisted no identity omits the ref rather than inventing one.
   */
  #nativeTurnRefFor(active: ActiveTurn): NativeTurnRef | undefined {
    const sessionId =
      this.#state.nativeRef?.nativeSessionId ?? nonEmptyString(this.#rpc.state.sessionId);
    if (!sessionId || active.userEntryId === null) return undefined;
    return nativeTurnRefSchema.parse({
      harnessId: omoHarnessId,
      nativeSessionId: sessionId,
      nativeTurnKey: omoHistoryTurnKey(active.userEntryId),
      formatVersion: 1,
    });
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(`omo-item-live-v1-${randomUUID()}`);
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  // --------------------------------------------------------------------- fault

  #fault(error: unknown): void {
    if (this.#phase !== "open" && this.#phase !== "closing") return;
    const normalized =
      error instanceof HarnessSessionFault ? error.error : sessionError(error, this.#rpc);
    this.#phase = "faulted";
    const active = this.#active;
    if (active) {
      // Closing the Interactions and terminating the Turn is one ordered path
      // inside #finishTurn; a second close outside it would not be exactly once.
      this.#finishTurn(
        active,
        { status: "failed", error: normalized },
        this.#nativeTurnRefFor(active),
      );
    }
    this.#event({ type: "session.faulted", error: normalized });
    this.#deferredFrames = [];
    // A faulted Session releases its native process; the Host resumes from the
    // persisted history instead of holding a dead Turn open.
    void this.#rpc.close().catch(() => undefined);
    this.#channel.end();
  }

  // --------------------------------------------------------------------- close

  async #close(): Promise<void> {
    if (this.#phase === "closed") return;
    const wasFaulted = this.#phase === "faulted";
    if (!wasFaulted) this.#phase = "closing";
    const active = this.#active;
    if (active && !wasFaulted) {
      active.cancellationRequested = true;
      this.#closeAllInteractions(active, "cancelled");
      if (this.#rpc.fault === null) {
        await this.#rpc
          .send("abort", { clearQueue: true }, { timeoutMs: this.#abortTimeoutMs })
          .catch(() => undefined);
        await Promise.race([active.completion, delay(this.#closeTurnTimeoutMs)]);
      }
    }
    let closeFailure: unknown;
    try {
      await this.#rpc.close();
    } catch (error) {
      closeFailure = error;
    }
    if (closeFailure === undefined && this.#prewarmSessionFile !== null && !this.#turnAccepted) {
      // The engine process has exited. A create-kind Session that never
      // accepted a Turn is prewarm-only, and real 5.1.83 leaves its empty
      // session file behind (task-9 evidence); remove it so close leaves no
      // orphan. A locked file simply keeps the pre-fix state — never a failed
      // close.
      await unlink(this.#prewarmSessionFile).catch(() => undefined);
    }
    const stillActive = this.#active;
    if (stillActive) {
      this.#finishTurn(
        stillActive,
        {
          status: "failed",
          error: invalidState("OmO Session closed before its active Turn settled"),
        },
        this.#nativeTurnRefFor(stillActive),
      );
    }
    if (closeFailure !== undefined && this.#phase !== "faulted") {
      const error = sessionError(closeFailure, this.#rpc);
      this.#phase = "faulted";
      this.#event({ type: "session.faulted", error });
    } else if (this.#phase !== "faulted") {
      this.#phase = "closed";
    }
    this.#deferredFrames = [];
    this.#channel.end();
    // The pump ends with the transport stream; awaiting it proves no frame is
    // still being projected after the output stream closed.
    await this.#pump.catch(() => undefined);
    if (closeFailure !== undefined) throw closeFailure;
  }
}

/** `data.disposition` of a prompt answer; older hosts omit data. */
function readDisposition(data: unknown): "started" | "queued" | "handled" | "unknown" {
  if (!isRecord(data)) return "unknown";
  const value = data.disposition;
  return value === "started" || value === "queued" || value === "handled" ? value : "unknown";
}

/** Reads a `get_entries` answer's entries and page cursor. */
function historyPage(
  data: unknown,
  command: string,
): { entries: unknown[]; hasMore: boolean; next: string | undefined } {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    throw new OmoSessionProtocolError(`OmO ${command} response has no Entries array`);
  }
  const next = nonEmptyString(data.nextSince) ?? nonEmptyString(data.next_before) ?? undefined;
  return { entries: data.entries, hasMore: data.hasMore === true, next };
}

function userMessageEntryId(entry: unknown): string | null {
  if (!isRecord(entry) || entry.type !== "message") return null;
  if (!isRecord(entry.message) || entry.message.role !== "user") return null;
  return nonEmptyString(entry.id);
}
