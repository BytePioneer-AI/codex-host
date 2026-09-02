import { spawn } from "node:child_process";

import {
  HarnessOutputChannel,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessModelCatalog,
  type HarnessOutput,
  type HarnessPermissionModeId,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostCommandExecutionItem,
  type HostEvent,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostUsage,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ResumeSessionInput,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { resolveCodeBuddyExecutable } from "./command.js";
import { readCodeBuddyTranscript } from "./history.js";
import {
  parseCodeBuddyTranscript,
  snapshotFromTranscriptTurns,
  type CodeBuddyTranscriptTurn,
} from "./history.js";
import { resolveModelCatalogFromCli } from "./model-catalog.js";
import {
  CODEBUDDY_PERMISSION_MODE_CATALOG,
  isKnownCodeBuddyPermissionModeId,
} from "./permission-modes.js";
import {
  CodeBuddyStreamProcess,
  codebuddySpawnArgs,
  initInfoFromFrame,
  type CodeBuddyStreamFrame,
  type CodeBuddyTurnResult,
  type SpawnDependency,
} from "./stream-protocol.js";
import { CodeBuddyTurnAccumulator, type CodeBuddyTurnProjection } from "./turn-accumulator.js";
import { usageFromTurnResult } from "./usage.js";

export const CODEBUDDY_HARNESS_ID: HarnessId = harnessIdSchema.parse("codebuddy");

const INSPECT_TIMEOUT_MS = 15_000;
const TOOL_OUTPUT_LIMIT = 16_000;

const SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export interface CodeBuddyAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  modelCatalog?: HarnessModelCatalog;
  inspectTimeoutMs?: number;
  spawn?: SpawnDependency;
}

export interface CodeBuddyAdapterDependencies {
  environment: NodeJS.ProcessEnv;
  spawn: SpawnDependency;
}

function errorOf(
  code: HarnessError["code"],
  message: string,
  options: {
    retryable: boolean;
    diagnostic?: string | undefined;
    stage?: string | undefined;
  } = { retryable: false },
): HarnessError {
  return {
    code,
    message,
    retryable: options.retryable,
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
  };
}

interface ActiveTurn {
  command: TurnStartCommand;
  agentItem: HostAgentMessageItem | null;
  reasoningItem: HostReasoningItem | null;
  tools: Map<string, HostItemSnapshot>;
  completedItemIds: Set<string>;
  cancellationRequested: boolean;
}

interface CompletedTurnRecord {
  turnKey: string | null;
  input: { type: "text"; text: string }[];
  items: HostItemSnapshot[];
  outcome: "succeeded" | "failed" | "cancelled";
}

class CodeBuddySession implements HarnessSession {
  readonly harnessId: HarnessId = CODEBUDDY_HARNESS_ID;
  readonly capabilities: HarnessSessionCapabilities = SESSION_CAPABILITIES;
  readonly outputs: AsyncIterable<HarnessOutput>;

  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cwd: string;
  readonly #dependencies: CodeBuddyAdapterDependencies;
  readonly #onClosed: () => void;
  #requestedModelId: string | null;
  #requestedPermissionModeId: HarnessPermissionModeId | null;
  readonly #resumeSessionId: string | null;
  readonly #sessionEnvironment: Record<string, string | undefined> | null;
  readonly #toolOutputLimit: number;

  #accumulator: CodeBuddyTurnAccumulator | null = null;
  #active: ActiveTurn | null = null;
  #completedTurns: CompletedTurnRecord[] = [];
  #historyTurns: CodeBuddyTranscriptTurn[] = [];
  #initialState: HarnessSessionState;
  #initialUsage: HostUsage | null = null;
  #phase: "open" | "closed" | "faulted" = "open";
  #process: CodeBuddyStreamProcess | null = null;
  #suppressProcessExit = false;
  #state: HarnessSessionState;
  #turnCounter = 0;
  #usage: HostUsage | null = null;

  constructor(
    input: { cwd: string; environment?: Record<string, string | undefined> },
    dependencies: CodeBuddyAdapterDependencies,
    options: {
      requestedModelId: string | null;
      requestedPermissionModeId: HarnessPermissionModeId | null;
      resumeSessionId: string | null;
      toolOutputLimit: number;
      onClosed: () => void;
    },
  ) {
    this.#cwd = input.cwd;
    this.#sessionEnvironment = input.environment ?? null;
    this.#dependencies = dependencies;
    this.#onClosed = options.onClosed;
    this.#requestedModelId = options.requestedModelId;
    this.#requestedPermissionModeId = options.requestedPermissionModeId;
    this.#resumeSessionId = options.resumeSessionId;
    this.#toolOutputLimit = options.toolOutputLimit;
    this.outputs = this.#channel.outputs;
    this.#initialState = {};
    this.#state = this.#initialState;
  }

  get initialState(): HarnessSessionState {
    return this.#initialState;
  }

  get initialUsage(): HostUsage | null {
    return this.#initialUsage;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#phase !== "open") {
      return {
        ok: false,
        error: errorOf("invalidState", "CodeBuddy Session is not open", { retryable: false }),
      };
    }
    if (this.#active) {
      return {
        ok: false,
        error: errorOf("sessionBusy", "CodeBuddy Session has an active Turn", { retryable: true }),
      };
    }
    const sessionId = this.#nativeSessionId();
    if (!sessionId) {
      // No confirmed native identity yet (no Turn has run): the live history
      // is still accurate for a fresh Session.
      return { ok: true, value: { ...this.#snapshotFromRecords(), state: this.#state } };
    }
    const transcript = readCodeBuddyTranscript(this.#cwd, sessionId);
    if (transcript === null) {
      if (this.#historyTurns.length === 0 && this.#completedTurns.length === 0) {
        return { ok: true, value: { turns: [], state: this.#state } };
      }
      return { ok: true, value: { ...this.#snapshotFromRecords(), state: this.#state } };
    }
    this.#historyTurns = parseCodeBuddyTranscript(transcript);
    return {
      ok: true,
      value: {
        ...snapshotFromTranscriptTurns(this.#historyTurns, {
          harnessId: this.harnessId,
          nativeSessionId: sessionId,
        }),
        state: this.#state,
      },
    };
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
      return {
        ok: false,
        error: errorOf("invalidState", "CodeBuddy Session is not open", { retryable: false }),
      };
    }
    switch (command.type) {
      case "turn.start":
        return this.#startTurn(command);
      case "turn.cancel":
        return this.#cancelTurn(command);
      case "interaction.respond":
        return {
          ok: false,
          error: errorOf("invalidRequest", "CodeBuddy Session has no pending Interaction", {
            retryable: false,
          }),
        };
      case "thinking.select":
        return {
          ok: false,
          error: errorOf(
            "unsupported",
            "CodeBuddy CLI does not support Thinking selection on an open Session",
            { retryable: false },
          ),
        };
      case "model.select":
        return this.#selectModel(command);
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
    }
  }

  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.#killProcess();
    this.#endActiveItems({ status: "cancelled", reason: "Session closed" });
    if (this.#active) {
      const turnId = this.#active.command.turnId;
      this.#active = null;
      this.#event({
        type: "turn.completed",
        turnId,
        outcome: { status: "cancelled", reason: "Session closed" },
      });
    }
    this.#channel.end();
    this.#onClosed();
  }

  // ---- Turn execution ------------------------------------------------------

  #startTurn(command: TurnStartCommand): HarnessResult<TurnStartAccepted> {
    if (this.#active) {
      return {
        ok: false,
        error: errorOf("sessionBusy", "CodeBuddy Session already has an active Turn", {
          retryable: true,
        }),
      };
    }
    const text = command.input
      .map((input) => input.text)
      .join("\n")
      .trim();
    if (text.length === 0) {
      return {
        ok: false,
        error: errorOf("invalidRequest", "CodeBuddy text Turn must not be empty", {
          retryable: false,
        }),
      };
    }
    if (!this.#ensureProcess()) {
      return {
        ok: false,
        error: errorOf("unavailable", "CodeBuddy CLI process could not be started", {
          retryable: true,
        }),
      };
    }
    const process = this.#process;
    if (!process || !process.writeTurnInput(text)) {
      return {
        ok: false,
        error: errorOf("processExited", "CodeBuddy CLI process is no longer running", {
          retryable: true,
        }),
      };
    }
    this.#turnCounter += 1;
    // Each Turn projects its own frame sequence; accumulators are not reused
    // across Turns.
    this.#accumulator = new CodeBuddyTurnAccumulator((projection) => {
      this.#handleProjection(projection);
    });
    this.#active = {
      command,
      agentItem: null,
      reasoningItem: null,
      tools: new Map(),
      completedItemIds: new Set(),
      cancellationRequested: false,
    };
    this.#event({ type: "turn.started", turnId: command.turnId });
    return { ok: true, value: { turnId: command.turnId } };
  }

  #cancelTurn(command: TurnCancelCommand): HarnessResult<TurnCancelAccepted> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: errorOf("invalidRequest", "Turn cancel does not reference the active Turn", {
          retryable: false,
        }),
      };
    }
    active.cancellationRequested = true;
    this.#killProcess();
    return { ok: true, value: { cancellationRequested: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (!isKnownCodeBuddyPermissionModeId(command.permissionModeId)) {
      return {
        ok: false,
        error: errorOf("invalidRequest", "Unknown CodeBuddy Permission Mode", {
          retryable: false,
        }),
      };
    }
    if (this.#active) {
      return {
        ok: false,
        error: errorOf("sessionBusy", "CodeBuddy cannot change Permission Mode during a Turn", {
          retryable: true,
        }),
      };
    }
    this.#requestedPermissionModeId = command.permissionModeId;
    // CodeBuddy applies Permission Mode when the CLI process starts. Stop an
    // idle process so the next Turn resumes the same native Session with the
    // newly selected mode.
    this.#restartProcessForConfiguration();
    this.#state = {
      ...this.#state,
      effectivePermissionModeId: command.permissionModeId,
    };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: errorOf("sessionBusy", "CodeBuddy cannot change Model during a Turn", {
          retryable: true,
        }),
      };
    }
    const model = harnessModelRefSchema.parse(command.model);
    this.#requestedModelId = model.id;
    // CodeBuddy applies Model when the CLI process starts. Stop an idle
    // process so the next Turn resumes the same native Session with the new
    // Model.
    this.#restartProcessForConfiguration();
    this.#state = {
      ...this.#state,
      effectiveModel: model,
      resolvedModelLabel: model.id,
    };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  // ---- Process lifecycle ---------------------------------------------------

  #nativeSessionId(): string | null {
    return this.#state.nativeRef?.nativeSessionId ?? this.#resumeSessionId ?? null;
  }

  #childEnvironment(): NodeJS.ProcessEnv {
    return { ...this.#dependencies.environment, ...this.#sessionEnvironment };
  }

  #ensureProcess(): boolean {
    if (this.#process) return true;
    const sessionId = this.#resumeSessionId ?? this.#state.nativeRef?.nativeSessionId ?? undefined;
    const args = codebuddySpawnArgs({
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
      ...(this.#requestedModelId ? { model: this.#requestedModelId } : {}),
      ...(this.#requestedPermissionModeId
        ? { permissionMode: this.#requestedPermissionModeId }
        : {}),
    });
    try {
      this.#process = new CodeBuddyStreamProcess(
        {
          cwd: this.#cwd,
          executable: resolveCodeBuddyExecutable({
            environment: this.#dependencies.environment,
          }),
          args,
          environment: this.#childEnvironment(),
          spawn: this.#dependencies.spawn,
        },
        {
          onFrame: (frame) => this.#handleFrame(frame),
          onExit: (exit) => this.#handleExit(exit),
        },
      );
    } catch {
      this.#process = null;
      return false;
    }
    return true;
  }

  #killProcess(): void {
    this.#process?.kill();
    this.#process = null;
  }

  #restartProcessForConfiguration(): void {
    if (!this.#process) return;
    this.#suppressProcessExit = true;
    this.#process.kill();
    this.#process = null;
  }

  #handleExit(exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
  }): void {
    this.#process = null;
    if (this.#suppressProcessExit) {
      this.#suppressProcessExit = false;
      return;
    }
    const active = this.#active;
    if (active) {
      const turnId = active.command.turnId;
      const cancelled = active.cancellationRequested;
      this.#endActiveItems(
        cancelled
          ? { status: "cancelled", reason: "Cancelled by user" }
          : {
              status: "failed",
              error: errorOf("processExited", "CodeBuddy CLI exited during the Turn", {
                retryable: true,
                diagnostic: exit.stderrTail || undefined,
              }),
            },
      );
      this.#active = null;
      this.#completedTurns.push({
        turnKey: null,
        input: active.command.input,
        items: this.#recordedItems(active),
        outcome: cancelled ? "cancelled" : "failed",
      });
      this.#event({
        type: "turn.completed",
        turnId,
        outcome: cancelled
          ? { status: "cancelled", reason: "Cancelled by user" }
          : {
              status: "failed",
              error: errorOf("processExited", "CodeBuddy CLI exited during the Turn", {
                retryable: true,
                diagnostic: exit.stderrTail || undefined,
              }),
            },
      });
      return;
    }
    if (this.#phase === "open") {
      // An idle CodeBuddy print process should not exit on its own.
      this.#fault(
        errorOf("processExited", "CodeBuddy CLI process exited unexpectedly", {
          retryable: false,
          diagnostic: exit.stderrTail || undefined,
        }),
      );
    }
  }

  #handleFrame(frame: CodeBuddyStreamFrame): void {
    const active = this.#active;
    if (active) {
      this.#accumulator?.handleFrame(frame);
      return;
    }
    // Frames outside an active Turn: only `system/init` matters (resume
    // confirmation or first-turn identity — identity is also relayed through
    // the accumulator when a Turn is active).
    const init = initInfoFromFrame(frame);
    if (init) this.#publishInitState(init.sessionId, init.model, init.permissionMode);
  }

  #publishInitState(
    sessionId: string,
    modelId: string | null,
    permissionModeId: string | null,
  ): void {
    const expected = this.#resumeSessionId;
    if (expected && sessionId !== expected) {
      this.#fault(
        errorOf("sessionNotFound", `CodeBuddy Session '${expected}' could not be resumed`, {
          retryable: false,
        }),
      );
      return;
    }
    if (this.#state.nativeRef?.nativeSessionId === sessionId) return;
    this.#state = {
      nativeRef: this.#sessionRef(sessionId),
      ...(modelId
        ? {
            effectiveModel: harnessModelRefSchema.parse({ id: modelId }),
            resolvedModelLabel: modelId,
          }
        : {}),
      ...(permissionModeId
        ? { effectivePermissionModeId: harnessPermissionModeIdSchema.parse(permissionModeId) }
        : {}),
    };
    this.#event({ type: "session.state.changed", state: this.#state });
  }

  #sessionRef(sessionId: string): NativeSessionRef {
    return nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: sessionId,
      formatVersion: 1,
    });
  }

  // ---- Turn projections ----------------------------------------------------

  #handleProjection(projection: CodeBuddyTurnProjection): void {
    const active = this.#active;
    if (!active || this.#phase !== "open") return;
    const turnId = active.command.turnId;
    switch (projection.kind) {
      case "init": {
        this.#publishInitState(
          projection.info.sessionId,
          projection.info.model,
          projection.info.permissionMode,
        );
        return;
      }
      case "text.delta": {
        if (!active.agentItem) {
          active.agentItem = {
            type: "agentMessage",
            itemId: hostItemIdSchema.parse(`agent-${turnId}-${active.tools.size}`),
            text: "",
          };
          this.#event({ type: "item.started", turnId, item: { ...active.agentItem } });
        }
        active.agentItem.text += projection.delta;
        this.#event({
          type: "item.updated",
          turnId,
          itemId: active.agentItem.itemId,
          update: { type: "text.append", text: projection.delta },
        });
        return;
      }
      case "reasoning.delta": {
        if (!active.reasoningItem) {
          active.reasoningItem = {
            type: "reasoning",
            itemId: hostItemIdSchema.parse(`reasoning-${turnId}-${active.tools.size}`),
            text: "",
          };
          this.#event({ type: "item.started", turnId, item: { ...active.reasoningItem } });
        }
        active.reasoningItem.text += projection.delta;
        this.#event({
          type: "item.updated",
          turnId,
          itemId: active.reasoningItem.itemId,
          update: { type: "text.append", text: projection.delta },
        });
        return;
      }
      case "tool.started": {
        const item: HostCommandExecutionItem | HostToolExecutionItem =
          projection.toolName === "Bash" || projection.toolName === "PowerShell"
            ? {
                type: "commandExecution",
                itemId: hostItemIdSchema.parse(`command-${projection.callId}`),
                command:
                  typeof (projection.input as { command?: unknown })?.command === "string"
                    ? (projection.input as { command: string }).command
                    : projection.toolName,
              }
            : {
                type: "toolExecution",
                itemId: hostItemIdSchema.parse(`tool-${projection.callId}`),
                toolName: projection.toolName,
                arguments: projection.input as never,
              };
        const snapshot: HostItemSnapshot = { item, outcome: { status: "succeeded" } };
        active.tools.set(projection.callId, snapshot);
        this.#event({ type: "item.started", turnId, item: { ...item } });
        return;
      }
      case "tool.completed": {
        const snapshot = active.tools.get(projection.callId);
        if (!snapshot) return;
        const text = projection.outputText ?? "";
        const isTruncated = text.length > this.#toolOutputLimit;
        const clipped = isTruncated ? text.slice(0, this.#toolOutputLimit) : text;
        if (snapshot.item.type === "toolExecution") {
          snapshot.item.output = {
            content: [{ type: "text", text: clipped }],
            ...(isTruncated ? { truncated: true } : {}),
          };
          this.#event({
            type: "item.updated",
            turnId,
            itemId: snapshot.item.itemId,
            update: {
              type: "output.replace",
              output: {
                content: [{ type: "text", text: clipped }],
                ...(isTruncated ? { truncated: true } : {}),
              },
            },
          });
        } else if (snapshot.item.type === "commandExecution") {
          snapshot.item.output = clipped;
          if (isTruncated) snapshot.item.outputTruncated = true;
          this.#event({
            type: "item.updated",
            turnId,
            itemId: snapshot.item.itemId,
            update: { type: "output.append", text: clipped },
          });
        }
        if (projection.isError) {
          snapshot.outcome = {
            status: "failed",
            error: errorOf("nativeFailure", "CodeBuddy tool execution failed", {
              retryable: false,
            }),
          };
        }
        active.completedItemIds.add(snapshot.item.itemId);
        this.#event({ type: "item.completed", turnId, snapshot: { ...snapshot } });
        return;
      }
      case "completed": {
        this.#completeActiveTurn(projection.result);
        return;
      }
    }
  }

  #recordedItems(active: ActiveTurn): HostItemSnapshot[] {
    const items: HostItemSnapshot[] = [];
    if (active.agentItem) {
      items.push({ item: active.agentItem, outcome: { status: "succeeded" } });
    }
    if (active.reasoningItem) {
      items.push({ item: active.reasoningItem, outcome: { status: "succeeded" } });
    }
    items.push(...active.tools.values());
    return items;
  }

  #endActiveItems(outcome: HostItemSnapshot["outcome"]): void {
    const active = this.#active;
    if (!active) return;
    const turnId = active.command.turnId;
    for (const snapshot of this.#recordedItems(active)) {
      if (active.completedItemIds.has(snapshot.item.itemId)) continue;
      if (snapshot.outcome.status === "succeeded") {
        snapshot.outcome = outcome;
        active.completedItemIds.add(snapshot.item.itemId);
        this.#event({ type: "item.completed", turnId, snapshot: { ...snapshot } });
      }
    }
  }

  #completeActiveTurn(result: CodeBuddyTurnResult): void {
    const active = this.#active;
    if (!active) return;
    const turnId = active.command.turnId;
    const sessionId = result.sessionId ?? this.#state.nativeRef?.nativeSessionId ?? null;
    if (sessionId && !this.#state.nativeRef) {
      this.#publishInitState(sessionId, null, null);
    }
    // Ensure the agent message item exists even when the Turn produced no
    // streamed text (e.g. a failed Turn with an empty result).
    if (!active.agentItem) {
      active.agentItem = {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(`agent-${turnId}-final`),
        text: "",
      };
      this.#event({ type: "item.started", turnId, item: { ...active.agentItem } });
    }
    const turnOutcome = result.is_error
      ? {
          status: "failed" as const,
          error: errorOf("nativeFailure", result.resultText || "CodeBuddy Turn failed", {
            retryable: false,
          }),
        }
      : ({ status: "succeeded" } as const);
    this.#endActiveItems(turnOutcome);
    const usage = usageFromTurnResult(result, this.#state.effectiveModel?.id ?? null);
    if (usage) {
      this.#usage = usage;
      this.#event({ type: "session.usage.changed", usage, observedForTurnId: turnId });
    }
    const items = this.#recordedItems(active);
    this.#active = null;
    this.#completedTurns.push({
      turnKey: this.#turnKeyFromTranscript(sessionId),
      input: active.command.input,
      items,
      outcome: result.is_error ? "failed" : "succeeded",
    });
    const nativeTurnKey = this.#completedTurns[this.#completedTurns.length - 1]?.turnKey ?? null;
    this.#event({
      type: "turn.completed",
      turnId,
      ...(nativeTurnKey && sessionId
        ? {
            nativeTurnRef: {
              harnessId: this.harnessId,
              nativeSessionId: sessionId,
              nativeTurnKey,
              formatVersion: 1,
            },
          }
        : {}),
      outcome: turnOutcome,
    });
  }

  /**
   * Reads the persisted transcript to find the stable user-message id of the
   * most recent Turn. Returns `null` when session persistence is disabled or
   * the transcript cannot be located.
   */
  #turnKeyFromTranscript(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const transcript = readCodeBuddyTranscript(this.#cwd, sessionId);
    if (transcript === null) return null;
    const turns = parseCodeBuddyTranscript(transcript);
    return turns.at(-1)?.nativeTurnKey ?? null;
  }

  #snapshotFromRecords(): HostThreadSnapshot {
    return {
      turns: this.#completedTurns.map((record, index) => ({
        nativeTurnRef: {
          harnessId: this.harnessId,
          nativeSessionId: this.#nativeSessionId() ?? `unconfirmed-${index + 1}`,
          nativeTurnKey: record.turnKey ?? `codebuddy-turn-${index + 1}`,
          formatVersion: 1,
        },
        input: record.input,
        items: record.items,
        outcome:
          record.outcome === "succeeded"
            ? { status: "succeeded" as const }
            : record.outcome === "cancelled"
              ? { status: "cancelled" as const, reason: "Cancelled by user" }
              : { status: "unknown" as const, reason: "Turn failed without a persisted outcome" },
      })),
    };
  }

  #fault(error: HarnessError): void {
    if (this.#phase !== "open") return;
    this.#endActiveItems({ status: "failed", error });
    const active = this.#active;
    if (active) {
      const turnId = active.command.turnId;
      this.#active = null;
      this.#event({ type: "turn.completed", turnId, outcome: { status: "failed", error } });
    }
    this.#phase = "faulted";
    this.#killProcess();
    this.#event({ type: "session.faulted", error });
    this.#channel.end();
    this.#onClosed();
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class CodeBuddyAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = CODEBUDDY_HARNESS_ID;

  readonly #options: CodeBuddyAdapterOptions;
  readonly #sessions = new Set<CodeBuddySession>();
  #inspection: { cwd: string | null; inspection: HarnessInspection } | null = null;

  constructor(options: CodeBuddyAdapterOptions = {}) {
    this.#options = options;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const cwd = input.cwd ?? process.cwd();
    if (this.#inspection && !input.refresh) {
      if (this.#inspection.cwd === cwd) return this.#inspection.inspection;
    }
    const inspection = await this.#runInspection(cwd);
    this.#inspection = { cwd, inspection };
    return inspection;
  }

  async #runInspection(cwd: string): Promise<HarnessInspection> {
    let executable: string;
    try {
      executable = resolveCodeBuddyExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment: this.#options.environment ?? process.env,
      });
    } catch {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "CodeBuddy CLI executable was not found",
          retryable: false,
        },
      };
    }
    try {
      const catalog = await resolveModelCatalogFromCli(executable, cwd, {
        timeoutMs: this.#options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS,
        fallback: this.#options.modelCatalog ?? null,
        ...(this.#options.spawn ? { spawn: this.#options.spawn } : {}),
      });
      return {
        status: "ready",
        catalog,
        permissionModes: CODEBUDDY_PERMISSION_MODE_CATALOG,
        capabilities: SESSION_CAPABILITIES,
      };
    } catch (error) {
      return {
        status: "unavailable",
        error: {
          code: "unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (input.kind === "fork") {
      return {
        ok: false,
        error: errorOf("unsupported", "CodeBuddy does not support Fork", { retryable: false }),
      };
    }
    if (input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: errorOf("unsupported", "CodeBuddy does not support Rollback", { retryable: false }),
      };
    }
    if (input.kind === "create") {
      return this.#openCreate(input);
    }
    return this.#openResume(input);
  }

  #openCreate(input: CreateSessionInput): HarnessResult<HarnessSession> {
    let permissionModeId: HarnessPermissionModeId | null = null;
    if (input.permissionModeId) {
      if (!isKnownCodeBuddyPermissionModeId(input.permissionModeId)) {
        return {
          ok: false,
          error: errorOf("invalidRequest", "Unknown CodeBuddy Permission Mode", {
            retryable: false,
          }),
        };
      }
      permissionModeId = input.permissionModeId;
    } else if (input.executionPolicy === "unattended-full-access") {
      // Unattended delegation maps to the CLI's full bypass mode.
      permissionModeId = harnessPermissionModeIdSchema.parse("bypassPermissions");
    }
    const modelId = input.model ? harnessModelRefSchema.parse(input.model).id : null;
    const session = new CodeBuddySession(
      { cwd: input.cwd, ...(input.environment ? { environment: input.environment } : {}) },
      this.#dependencies(),
      {
        requestedModelId: modelId,
        requestedPermissionModeId: permissionModeId,
        resumeSessionId: null,
        toolOutputLimit: TOOL_OUTPUT_LIMIT,
        onClosed: () => this.#sessions.delete(session),
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  #openResume(input: ResumeSessionInput): HarnessResult<HarnessSession> {
    const ref = input.nativeRef;
    if (ref.harnessId !== this.harnessId) {
      return {
        ok: false,
        error: errorOf("sessionNotFound", "Native Ref belongs to another Harness", {
          retryable: false,
        }),
      };
    }
    const session = new CodeBuddySession(
      { cwd: input.cwd, ...(input.environment ? { environment: input.environment } : {}) },
      this.#dependencies(),
      {
        requestedModelId: null,
        requestedPermissionModeId: null,
        resumeSessionId: ref.nativeSessionId,
        toolOutputLimit: TOOL_OUTPUT_LIMIT,
        onClosed: () => this.#sessions.delete(session),
      },
    );
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  #dependencies(): CodeBuddyAdapterDependencies {
    return {
      environment: this.#options.environment ?? process.env,
      spawn: this.#options.spawn ?? spawn,
    };
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions];
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.#sessions.clear();
    this.#inspection = null;
  }
}
