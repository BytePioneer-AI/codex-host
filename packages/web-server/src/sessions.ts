/**
 * The `session/*` Remote surface backed by codexhost Harness Sessions.
 *
 * Each Web Session is bound to one Harness when its first Turn starts (from the model selection
 * the user made in the composer, or the catalog default). The Harness Session's outputs are
 * projected into the Session journal by {@link TurnProjector}.
 */

import { createHash, randomUUID } from "node:crypto";

import type { HarnessRegistry, HarnessSessionLike } from "./harnesses.ts";
import {
  TurnProjector,
  type HostItem,
  type HostItemOutcome,
  type HostItemUpdate,
  type TurnOutcomeShape,
} from "./projector.ts";
import {
  SessionLog,
  defaultProjections,
  type SessionHeader,
  type WireEvent,
} from "./session-log.ts";
import { type DataDir, requestOf } from "./store.ts";
import {
  type EventHub,
  RpcError,
  type RpcRegistry,
  type StreamRegistry,
  type StreamSink,
} from "./transport.ts";
import type { Workspaces } from "./workspaces.ts";

interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface SessionMeta {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  harnessId?: string;
  nativeRef?: unknown;
  selection?: ModelSelection;
  lastUsed?: ModelSelection;
  permissionModeId?: string;
  title?: string;
  blank: boolean;
  lastPromptAt?: number;
  /** Native session id this Web session was imported from. */
  nativeSessionId?: string;
  /** History replay state for imported sessions. */
  backfill?: "pending" | "done" | "failed";
  /** Native checkpoint per completed DSH turn number (fork points). */
  checkpoints?: Record<string, unknown>;
  /** Subagent children: parent link and the Harness's id for the child. */
  origin?: "subagent";
  parentSessionId?: string;
  nativeSubagentId?: string;
}

interface QueuedPrompt {
  id: string;
  requestId: string;
  content: Array<{ type: string; text?: string }>;
}

interface PendingInteraction {
  interactionId: string;
  cancel: () => void;
}

interface Runtime {
  meta: SessionMeta;
  log: SessionLog;
  harness?: HarnessSessionLike | undefined;
  opening?: Promise<HarnessSessionLike> | undefined;
  projector?: TurnProjector;
  turnId?: string | undefined;
  running: boolean;
  queue: QueuedPrompt[];
  interactions: Map<string, PendingInteraction>;
  backfilling?: Promise<void> | undefined;
  /** Settles once the current turn's `turn.start` reached the Harness (or failed). */
  starting?: Promise<void> | undefined;
  /** Running tool output tails waiting to be published (callId → text). */
  liveOutput?: Map<string, string>;
  liveOutputTimer?: ReturnType<typeof setTimeout> | undefined;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Set while the server deliberately closes the Harness Session (idle release). */
  releasing?: HarnessSessionLike | undefined;
}

const INDEX_FILE = "sessions/index.json";

/** Characters of running tool output kept for the live terminal card. */
const LIVE_OUTPUT_TAIL = 8000;

/** Close an idle Harness Session (and its native process) after this long without activity. */
const IDLE_RELEASE_MS = Number(process.env.CODEXHOST_IDLE_RELEASE_MS ?? 10 * 60_000);

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export interface SessionNotification {
  kind: "turn" | "approval" | "question" | "error";
  sessionId: string;
  title: string;
  body: string;
}

export class Sessions {
  /** Out-of-band notification sink (Web Push). */
  notifier: ((notification: SessionNotification) => void) | undefined;
  private readonly index: Record<string, SessionMeta>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly controlSinks = new Set<StreamSink>();
  /** Set while the server shuts down: open Turns end as interrupted, not failed. */
  private shuttingDown = false;

  constructor(
    private readonly data: DataDir,
    private readonly harnesses: HarnessRegistry,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
  ) {
    this.index = data.readJson<Record<string, SessionMeta>>(INDEX_FILE, {});
    const preferences = data.readJson<{ defaultSelection?: ModelSelection }>(
      "preferences.json",
      {},
    );
    if (preferences.defaultSelection !== undefined)
      harnesses.preferredSelection = preferences.defaultSelection;
  }

  private saveIndex(): void {
    this.data.writeJson(INDEX_FILE, this.index);
  }

  private saveMeta(meta: SessionMeta): void {
    meta.updatedAt = Date.now();
    this.index[meta.sessionId] = meta;
    this.saveIndex();
  }

  private runtime(sessionId: string): Runtime {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    const meta = this.index[sessionId];
    if (meta === undefined)
      throw new RpcError("session/not-found", `Unknown session ${sessionId}`, { sessionId });
    const header: SessionHeader = {
      version: 4,
      id: sessionId,
      createdAt: meta.createdAt,
      cwd: meta.cwd,
      isSeeded: false,
      agentPreset: "standard",
    };
    const log = new SessionLog(header, this.data, (id, key, value, seq) => {
      for (const sink of this.controlSinks)
        sink.push({ type: "projection", sessionId: id, key, value, seq });
    });
    // A fresh runtime never has a live Turn: close one a previous process left open.
    log.closeOrphanedTurn();
    this.coldProjections.delete(sessionId);
    const runtime: Runtime = { meta, log, running: false, queue: [], interactions: new Map() };
    this.runtimes.set(sessionId, runtime);
    // A draft that has not chosen a Harness shows the current default Harness's permission mode.
    if (
      meta.harnessId === undefined &&
      meta.permissionModeId === undefined &&
      meta.origin === undefined
    ) {
      void this.permissionCatalog(sessionId).then(
        (catalog) => {
          if (runtime.meta.harnessId === undefined && runtime.meta.permissionModeId === undefined) {
            runtime.log.setProjection("permissions", { currentValue: catalog.defaultPreset });
          }
        },
        () => undefined,
      );
    }
    return runtime;
  }

  /** Persisted projections of sessions without a live runtime, read once per process. */
  private readonly coldProjections = new Map<string, Record<string, unknown>>();

  summary(meta: SessionMeta): Record<string, unknown> {
    const runtime = this.runtimes.get(meta.sessionId);
    let projections = runtime?.log.projections;
    if (projections === undefined) {
      projections = this.coldProjections.get(meta.sessionId);
      if (projections === undefined) {
        projections = {
          ...defaultProjections(),
          ...this.data.readJson<Record<string, unknown>>(
            `sessions/${meta.sessionId}/projections.json`,
            {},
          ),
        };
        this.coldProjections.set(meta.sessionId, projections);
      }
    }
    return {
      sessionId: meta.sessionId,
      updatedAt: meta.lastPromptAt ?? meta.createdAt,
      agentAvailable: runtime !== undefined,
      running: runtime?.running ?? false,
      blank: meta.blank,
      cwd: meta.cwd,
      ...(meta.origin === undefined ? {} : { origin: meta.origin }),
      ...(meta.parentSessionId === undefined ? {} : { parentSessionId: meta.parentSessionId }),
      projections: {
        kind: "cached",
        asOfSeq: Math.max(runtime?.log.lastSeq ?? 0, 0),
        values: projections,
      },
    };
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  create(request: { workspaceId?: string; cwd?: string; sessionId?: string }): {
    sessionId: string;
    agentPreset: string;
  } {
    const sessionId = request.sessionId ?? `session-${randomUUID()}`;
    if (this.index[sessionId] !== undefined) return { sessionId, agentPreset: "standard" };
    const workspace =
      request.workspaceId === undefined ? undefined : this.workspaces.get(request.workspaceId);
    const cwd = request.cwd ?? workspace?.path;
    if (cwd === undefined)
      throw new RpcError("workspace/invalid-path", "A new session needs a workspace", { path: "" });
    const now = Date.now();
    const meta: SessionMeta = { sessionId, cwd, createdAt: now, updatedAt: now, blank: true };
    this.saveMeta(meta);
    this.workspaces.attachSession(sessionId, workspace?.workspaceId, cwd);
    const runtime = this.runtime(sessionId);
    this.events.emit("api-session/added", this.summary(runtime.meta));
    return { sessionId, agentPreset: "standard" };
  }

  /** Close the Harness Session once it has been idle for {@link IDLE_RELEASE_MS}. */
  private scheduleIdleRelease(runtime: Runtime, delay = IDLE_RELEASE_MS): void {
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
    if (runtime.harness === undefined) return;
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined;
      void this.releaseIfIdle(runtime);
    }, delay);
    runtime.idleTimer.unref?.();
  }

  private async releaseIfIdle(runtime: Runtime): Promise<void> {
    const session = runtime.harness;
    if (
      session === undefined ||
      runtime.running ||
      runtime.interactions.size > 0 ||
      runtime.opening !== undefined ||
      runtime.backfilling !== undefined
    )
      return;
    if (session.hasBackgroundWork?.() === true) {
      this.scheduleIdleRelease(runtime);
      return;
    }
    runtime.harness = undefined;
    runtime.releasing = session;
    try {
      await session.close();
    } catch (error) {
      console.error(`[session ${runtime.meta.sessionId}] idle release failed`, error);
    }
  }

  private async harnessFor(runtime: Runtime): Promise<HarnessSessionLike> {
    if (runtime.idleTimer !== undefined) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
    if (runtime.harness !== undefined) return runtime.harness;
    runtime.opening ??= this.openHarness(runtime);
    try {
      return await runtime.opening;
    } finally {
      runtime.opening = undefined;
    }
  }

  private async openHarness(runtime: Runtime): Promise<HarnessSessionLike> {
    const { meta } = runtime;
    let selection = meta.selection;
    if (meta.harnessId === undefined) {
      if (selection === undefined) {
        const catalog = await this.harnesses.modelCatalog();
        if (catalog.groups.length === 0) {
          throw new RpcError(
            "session/provider-credentials-unavailable",
            "No Harness is installed and ready on this host.",
            {},
          );
        }
        selection = { provider: catalog.default.provider, model: catalog.default.model };
        meta.selection = selection;
      }
      meta.harnessId = selection.provider;
      this.saveMeta(meta);
    }
    const harnessId = meta.harnessId;
    const adapter = await this.harnesses.adapter(harnessId);
    const common = {
      cwd: meta.cwd,
      ...(selection?.provider === harnessId ? { model: { id: selection.model } } : {}),
      ...(selection?.provider === harnessId && selection.reasoningEffort !== undefined
        ? { thinkingOptionId: selection.reasoningEffort }
        : {}),
      ...(meta.permissionModeId !== undefined ? { permissionModeId: meta.permissionModeId } : {}),
    };
    const input =
      meta.nativeRef === undefined
        ? { kind: "create", ...common }
        : { kind: "resume", nativeRef: meta.nativeRef, ...common };
    const result = await adapter.open(input);
    if (!result.ok) throw new RpcError(`harness/${result.error.code}`, result.error.message, {});
    const session = result.value;
    runtime.harness = session;
    this.applyState(runtime, session.initialState);
    void this.pump(runtime, session);
    return session;
  }

  private applyState(
    runtime: Runtime,
    state: HarnessSessionLike["initialState"] | undefined,
  ): void {
    if (state === undefined) return;
    const { meta } = runtime;
    let changed = false;
    if (
      state.nativeRef !== undefined &&
      JSON.stringify(state.nativeRef) !== JSON.stringify(meta.nativeRef)
    ) {
      meta.nativeRef = state.nativeRef;
      changed = true;
    }
    if (
      state.effectivePermissionModeId !== undefined &&
      state.effectivePermissionModeId !== meta.permissionModeId
    ) {
      meta.permissionModeId = state.effectivePermissionModeId;
      runtime.log.setProjection("permissions", { currentValue: state.effectivePermissionModeId });
      changed = true;
    }
    if (meta.harnessId !== undefined && state.effectiveModel !== undefined) {
      const lastUsed: ModelSelection = {
        provider: meta.harnessId,
        model: state.effectiveModel.id,
        ...(state.effectiveThinkingOptionId !== undefined
          ? { reasoningEffort: state.effectiveThinkingOptionId }
          : {}),
      };
      if (JSON.stringify(lastUsed) !== JSON.stringify(meta.lastUsed)) {
        meta.lastUsed = lastUsed;
        runtime.log.setProjection("modelSelection", { lastUsed, next: meta.selection ?? lastUsed });
        changed = true;
      }
    }
    if (changed) this.saveMeta(meta);
  }

  /** Single consumer of one Harness Session's outputs. */
  private async pump(runtime: Runtime, session: HarnessSessionLike): Promise<void> {
    try {
      const debug = process.env.CODEXHOST_DEBUG_EVENTS === "1";
      for await (const output of session.outputs) {
        if (debug)
          this.data.appendLine(`sessions/${runtime.meta.sessionId}/harness.jsonl`, {
            time: Date.now(),
            ...output,
          });
        try {
          if (output.kind === "interaction") this.onInteraction(runtime, output.interaction);
          else this.onEvent(runtime, output.event);
        } catch (error) {
          console.error(`[session ${runtime.meta.sessionId}] output handling failed`, error);
        }
      }
    } catch (error) {
      console.error(`[session ${runtime.meta.sessionId}] output stream failed`, error);
    }
    if (runtime.releasing === session) {
      runtime.releasing = undefined;
      return;
    }
    if (runtime.harness === session) {
      runtime.harness = undefined;
      if (runtime.running)
        this.endTurn(runtime, {
          status: "failed",
          error: { code: "processExited", message: "The Harness session ended." },
        });
    }
  }

  private onEvent(runtime: Runtime, event: Record<string, unknown> & { type: string }): void {
    switch (event.type) {
      case "session.state.changed":
        this.applyState(runtime, event.state as HarnessSessionLike["initialState"]);
        return;
      case "session.usage.changed": {
        const usage = event.usage as {
          inputTokens?: number;
          cachedInputTokens?: number;
          cacheWriteInputTokens?: number;
          outputTokens?: number;
          contextWindowTokens?: number;
          contextUsedTokens?: number;
        } | null;
        if (usage === null) return;
        runtime.log.setProjection("tokenUsage", {
          uncachedInputTokens: Math.max(
            (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0),
            0,
          ),
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedInputTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
        });
        if (usage.contextWindowTokens !== undefined) {
          runtime.log.setProjection("contextPressure", {
            contextWindow: usage.contextWindowTokens,
            ...(usage.contextUsedTokens !== undefined
              ? {
                  pressureTokens: usage.contextUsedTokens,
                  projectedTokens: usage.contextUsedTokens,
                }
              : {}),
          });
        }
        return;
      }
      case "turn.started":
        return;
      case "turn.autonomous.started": {
        if (runtime.projector !== undefined && !runtime.projector.isFinished) return;
        runtime.turnId = String(event.turnId);
        runtime.projector = this.newProjector(runtime);
        runtime.projector.beginAutonomous((event.input as unknown[] | undefined) ?? []);
        this.setRunning(runtime, true);
        return;
      }
      case "item.started": {
        const item = event.item as HostItem;
        if (item.type === "subagentDelegation") this.trackSubagents(runtime, item.subagents);
        this.projectorFor(runtime).itemStarted(item);
        return;
      }
      case "item.updated": {
        const update = event.update as HostItemUpdate;
        if (update.type === "subagents.replace") this.trackSubagents(runtime, update.subagents);
        this.projectorFor(runtime).itemUpdated(String(event.itemId), update);
        return;
      }
      case "item.completed": {
        const snapshot = event.snapshot as { item: HostItem; outcome: HostItemOutcome };
        if (snapshot.item.type === "subagentDelegation")
          this.trackSubagents(runtime, snapshot.item.subagents);
        this.projectorFor(runtime).itemCompleted(snapshot.item, snapshot.outcome);
        return;
      }
      case "subagent.state.changed":
      case "subagent.transcript.changed": {
        const child = this.childOf(runtime, String(event.nativeSubagentId));
        if (child === undefined) return;
        child.meta.backfill = "pending";
        this.saveMeta(child.meta);
        if (event.type === "subagent.state.changed")
          this.setRunning(child, event.status === "running" || event.status === "pending");
        return;
      }
      case "turn.completed": {
        const outcome = event.outcome as TurnOutcomeShape & { checkpoint?: unknown };
        if (outcome.checkpoint !== undefined && runtime.projector !== undefined)
          this.recordCheckpoint(runtime, runtime.projector.turn, outcome.checkpoint);
        this.endTurn(
          runtime,
          this.shuttingDown && outcome.status !== "succeeded"
            ? { status: "unknown", reason: "server shutdown" }
            : outcome,
        );
        return;
      }
      case "interaction.closed": {
        const pending = runtime.interactions.get(String(event.interactionId));
        if (pending !== undefined) {
          runtime.interactions.delete(String(event.interactionId));
          pending.cancel();
        }
        return;
      }
      case "session.faulted": {
        const error = event.error as { code: string; message: string };
        this.events.emit("api-session/error", runtime.meta.sessionId, error.message);
        this.endTurn(runtime, { status: "failed", error });
        return;
      }
      default:
        return;
    }
  }

  /** Publish running tool output as a throttled projection the terminal card reads. */
  private onToolOutput(runtime: Runtime, callId: string, output: string | undefined): void {
    runtime.liveOutput ??= new Map();
    if (output === undefined) runtime.liveOutput.delete(callId);
    else
      runtime.liveOutput.set(
        callId,
        output.length > LIVE_OUTPUT_TAIL ? output.slice(-LIVE_OUTPUT_TAIL) : output,
      );
    if (runtime.liveOutputTimer !== undefined) return;
    runtime.liveOutputTimer = setTimeout(
      () => {
        runtime.liveOutputTimer = undefined;
        runtime.log.setProjection(
          "codexhostToolOutput",
          Object.fromEntries(runtime.liveOutput ?? []),
        );
      },
      output === undefined ? 0 : 300,
    );
  }

  private newProjector(runtime: Runtime): TurnProjector {
    const selection = runtime.meta.lastUsed ?? runtime.meta.selection;
    return new TurnProjector(runtime.log, {
      live: true,
      onToolOutput: (callId, output) => this.onToolOutput(runtime, callId, output),
      cwd: runtime.meta.cwd,
      ...(selection === undefined
        ? {}
        : { model: { provider: selection.provider, model: selection.model } }),
    });
  }

  private projectorFor(runtime: Runtime): TurnProjector {
    if (runtime.projector === undefined || runtime.projector.isFinished) {
      // Output outside a Host-started Turn (late background work): open a synthetic Turn.
      runtime.projector = this.newProjector(runtime);
      runtime.projector.beginAutonomous([]);
      this.setRunning(runtime, true);
    }
    return runtime.projector;
  }

  private notify(runtime: Runtime, kind: SessionNotification["kind"], body: string): void {
    try {
      this.notifier?.({
        kind,
        sessionId: runtime.meta.sessionId,
        title: runtime.meta.title ?? "CodexHost",
        body,
      });
    } catch (error) {
      console.error("[notify] failed", error);
    }
  }

  /** Text of the last assistant message in the journal, for notification previews. */
  private lastAssistantText(runtime: Runtime): string {
    for (let index = runtime.log.events.length - 1; index >= 0; index -= 1) {
      const event = runtime.log.events[index] as WireEvent;
      if (event.type === "turn/start") break;
      if (event.type !== "assistant/message") continue;
      const text = textOf(
        (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message
          .content,
      );
      if (text.trim() !== "") return text;
    }
    return "";
  }

  private endTurn(runtime: Runtime, outcome: TurnOutcomeShape): void {
    for (const pending of runtime.interactions.values()) pending.cancel();
    runtime.interactions.clear();
    const wasOpen = runtime.projector !== undefined && !runtime.projector.isFinished;
    if (runtime.projector !== undefined && !runtime.projector.isFinished)
      runtime.projector.finish(outcome);
    if (wasOpen && runtime.queue.length === 0) {
      if (outcome.status === "succeeded") {
        const text = this.lastAssistantText(runtime).replace(/\s+/gu, " ").trim();
        this.notify(runtime, "turn", text === "" ? "Finished." : text.slice(0, 180));
      } else if (outcome.status === "failed") {
        this.notify(runtime, "error", outcome.error.message.slice(0, 180));
      }
    }
    runtime.turnId = undefined;
    this.updateStats(runtime);
    this.setRunning(runtime, false);
    this.scheduleIdleRelease(runtime);
    const next = runtime.queue.shift();
    if (next !== undefined) {
      this.publishQueue(runtime);
      void this.startTurn(runtime, next).catch((error: unknown) => {
        console.error(`[session ${runtime.meta.sessionId}] queued turn failed`, error);
      });
    }
  }

  private updateStats(runtime: Runtime): void {
    const events = runtime.log.events;
    const turns = events.filter((event) => event.type === "turn/start").length;
    const steps = events.filter((event) => event.type === "step/start").length;
    const previous = runtime.log.projections.sessionStats as Record<string, number>;
    runtime.log.setProjection("sessionStats", { ...previous, turns, steps });
    const outline: Array<{ turn: number; seq: number; prompt: string; response: string }> = [];
    for (const event of events) {
      if (event.type === "turn/start")
        outline.push({
          turn: (event.data as { turn: number }).turn,
          seq: event.seq,
          prompt: "",
          response: "",
        });
      const current = outline.at(-1);
      if (current === undefined) continue;
      if (event.type === "user/message" && current.prompt === "") {
        current.prompt = textOf(
          (event.data as { content: Array<{ type: string; text?: string }> }).content,
        ).slice(0, 200);
      }
      if (event.type === "assistant/message") {
        const text = textOf(
          (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message
            .content,
        );
        if (text !== "") current.response = text.slice(0, 200);
      }
    }
    runtime.log.setProjection("turnOutline", outline);
  }

  private setRunning(runtime: Runtime, running: boolean): void {
    if (runtime.running === running) return;
    runtime.running = running;
    this.events.emit("api-session/status", runtime.meta.sessionId, running);
  }

  private publishQueue(runtime: Runtime): void {
    runtime.log.setProjection("inbox", {
      "next-turn": runtime.queue.map((item) => ({
        content: item.content,
        source: { kind: "user", rpcId: item.requestId },
        role: "user",
        id: item.id,
      })),
      "next-step": [],
    });
  }

  private async startTurn(runtime: Runtime, prompt: QueuedPrompt): Promise<void> {
    const { meta } = runtime;
    const text = textOf(prompt.content);
    runtime.projector = this.newProjector(runtime);
    this.setRunning(runtime, true);
    runtime.projector.begin(prompt.content, prompt.requestId);
    if (meta.blank) {
      meta.blank = false;
      const title = text.replace(/\s+/gu, " ").trim().slice(0, 80) || "New session";
      meta.title = title;
      runtime.log.append("session/title", {
        title,
        messageSeqs: [runtime.log.lastSeq],
        source: { kind: "fallback" },
      });
      runtime.log.setProjection("title", title);
    }
    meta.lastPromptAt = Date.now();
    this.saveMeta(meta);
    runtime.log.setProjection("sessionListMetadata", {
      blank: false,
      lastPromptAt: meta.lastPromptAt,
    });
    this.events.emit("api-session/activity", meta.sessionId, meta.lastPromptAt);
    const projector = runtime.projector;
    runtime.starting = (async () => {
      let session: HarnessSessionLike;
      try {
        session = await this.harnessFor(runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.endTurn(runtime, {
          status: "failed",
          error: { code: error instanceof RpcError ? error.code : "unavailable", message },
        });
        return;
      }
      // Cancelled before the Harness was ready: never start the native turn.
      if (runtime.projector !== projector || projector.isFinished) return;
      const turnId = `turn-${randomUUID()}`;
      runtime.turnId = turnId;
      const result = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text }],
      });
      if (!result.ok) this.endTurn(runtime, { status: "failed", error: result.error });
    })();
    try {
      await runtime.starting;
    } finally {
      runtime.starting = undefined;
    }
  }

  /**
   * Redirect a running Turn: the new input goes to the head of the queue and the current Turn is
   * cancelled; when it settles, {@link endTurn} starts the queued input as the next Turn. This is
   * the codexhost steering contract (cancel, await the terminal state, then start).
   */
  private async steer(runtime: Runtime, prompt: QueuedPrompt): Promise<void> {
    await runtime.starting;
    // Harnesses that accept input into a running turn keep their work; others restart.
    const native =
      (runtime.harness?.capabilities as { steering?: { native?: boolean } } | undefined)?.steering
        ?.native === true;
    if (
      native &&
      runtime.harness !== undefined &&
      runtime.turnId !== undefined &&
      runtime.projector !== undefined &&
      !runtime.projector.isFinished
    ) {
      const result = await runtime.harness.execute({
        type: "turn.steer",
        turnId: runtime.turnId,
        input: [{ type: "text", text: textOf(prompt.content) }],
      });
      if (result.ok) {
        runtime.projector.steer(prompt.content, prompt.requestId);
        return;
      }
      console.error(
        `[session ${runtime.meta.sessionId}] native steer failed, restarting the turn`,
        result.error,
      );
    }
    runtime.queue.unshift(prompt);
    this.publishQueue(runtime);
    if (runtime.harness !== undefined && runtime.turnId !== undefined) {
      const result = await runtime.harness.execute({ type: "turn.cancel", turnId: runtime.turnId });
      if (!result.ok) this.endTurn(runtime, { status: "cancelled" });
    } else if (runtime.running) {
      this.endTurn(runtime, { status: "cancelled" });
    }
  }

  // ---- interactions ------------------------------------------------------------------------

  private onInteraction(
    runtime: Runtime,
    interaction: Record<string, unknown> & { type: string },
  ): void {
    const interactionId = String(interaction.interactionId);
    const sessionId = runtime.meta.sessionId;
    const respond = async (response: unknown): Promise<void> => {
      runtime.interactions.delete(interactionId);
      const session = runtime.harness;
      if (session === undefined) return;
      const result = await session.execute({
        type: "interaction.respond",
        interactionId,
        response,
      });
      if (!result.ok)
        console.error(`[session ${sessionId}] interaction response rejected`, result.error);
    };
    if (interaction.type === "approval") {
      const actions = interaction.actions as Array<{ id: string; label: string; effect: string }>;
      const allow =
        actions.find((action) => action.effect === "allowOnce") ??
        actions.find((action) => action.effect !== "deny");
      const deny = actions.find((action) => action.effect === "deny");
      const title = String(interaction.title ?? "Approval required");
      const description =
        typeof interaction.description === "string" ? interaction.description : undefined;
      const invocation = this.events.invoke("approval/request", sessionId, {
        toolName: title,
        reason: description === undefined ? title : `${title}\n\n${description}`,
        displayReason: { en: description === undefined ? title : `${title}\n\n${description}` },
      });
      runtime.interactions.set(interactionId, { interactionId, cancel: invocation.cancel });
      this.notify(runtime, "approval", `Approval needed: ${title}`);
      invocation.result.then(
        (value) => {
          const action = value === "allowed-once" ? allow : deny;
          if (action !== undefined) void respond({ type: "approval", actionId: action.id });
        },
        () => {
          // Withdrawn by the Harness or the server.
        },
      );
      return;
    }
    if (interaction.type === "question") {
      const questions = interaction.questions as Array<
        | {
            id: string;
            type: "choice";
            prompt: string;
            options: Array<{ value: string; label: string; description?: string }>;
            multiple: boolean;
            allowOther: boolean;
          }
        | { id: string; type: "text"; prompt: string }
      >;
      const items = questions.map((question) =>
        question.type === "choice"
          ? {
              id: question.id,
              question: question.prompt,
              ...(typeof interaction.title === "string" ? { header: interaction.title } : {}),
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
              multiSelect: question.multiple,
            }
          : { id: question.id, question: question.prompt },
      );
      const invocation = this.events.invoke("user-questions/request", sessionId, {
        questions: items,
      });
      runtime.interactions.set(interactionId, { interactionId, cancel: invocation.cancel });
      this.notify(runtime, "question", questions[0]?.prompt ?? "The agent has a question");
      invocation.result.then(
        (value) => {
          const answer = value as
            { answers?: Array<{ id: string; selected: string[]; custom?: string }> } | undefined;
          const answers: Record<string, string[]> = {};
          for (const question of questions) {
            const item = answer?.answers?.find((entry) => entry.id === question.id);
            if (item === undefined) continue;
            const values =
              question.type === "choice"
                ? item.selected.map(
                    (label) =>
                      question.options.find((option) => option.label === label)?.value ?? label,
                  )
                : [];
            if (item.custom !== undefined && item.custom !== "") values.push(item.custom);
            answers[question.id] = values;
          }
          void respond({ type: "question", answers });
        },
        () => {
          // Withdrawn.
        },
      );
    }
  }

  // ---- registration ------------------------------------------------------------------------

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    rpc.register("session/list", () => ({
      items: Object.values(this.index)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((meta) => this.summary(meta)),
    }));
    rpc.register("session/create", (args) => this.create(requestOf(args)));
    rpc.register("session/modelCatalog", async () => await this.harnesses.modelCatalog());
    rpc.register("session/selectModel", async (args) => {
      const request = requestOf<ModelSelection & { sessionId: string }>(args);
      const runtime = this.runtime(request.sessionId);
      const { meta } = runtime;
      if (meta.harnessId !== undefined && meta.harnessId !== request.provider) {
        throw new RpcError(
          "session/model-unavailable",
          `This session runs on ${this.harnesses.manifest(meta.harnessId)?.name ?? meta.harnessId}; start a new session to use another Harness.`,
          { provider: request.provider, model: request.model },
        );
      }
      const selection: ModelSelection = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
      };
      const previousProvider = meta.selection?.provider;
      meta.selection = selection;
      this.saveMeta(meta);
      this.harnesses.preferredSelection = selection;
      // An unbound session that switches Harness takes the new Harness's default permission mode
      // unless the user picked one explicitly.
      if (
        meta.harnessId === undefined &&
        meta.permissionModeId === undefined &&
        previousProvider !== selection.provider
      ) {
        void this.permissionCatalog(request.sessionId).then(
          (catalog) => {
            runtime.log.setProjection("permissions", { currentValue: catalog.defaultPreset });
          },
          () => undefined,
        );
      }
      this.data.writeJson("preferences.json", {
        ...this.data.readJson<Record<string, unknown>>("preferences.json", {}),
        defaultSelection: selection,
      });
      runtime.log.append("model/selection", selection);
      runtime.log.setProjection("modelSelection", {
        lastUsed: meta.lastUsed ?? null,
        next: selection,
      });
      const session = runtime.harness;
      if (session !== undefined) {
        const modelResult = await session.execute({
          type: "model.select",
          model: { id: selection.model },
        });
        if (!modelResult.ok)
          throw new RpcError("session/model-unavailable", modelResult.error.message, {
            provider: selection.provider,
            model: selection.model,
          });
        if (selection.reasoningEffort !== undefined) {
          const thinking = await session.execute({
            type: "thinking.select",
            thinkingOptionId: selection.reasoningEffort,
          });
          if (!thinking.ok) console.error("[session] thinking selection rejected", thinking.error);
        }
      }
      return { selected: selection };
    });
    rpc.register("session/prompt", async (args) => {
      const request = requestOf<{
        requestId: string;
        sessionId: string;
        mode: "queue" | "steer";
        content: Array<{ type: string; text?: string }>;
      }>(args);
      const runtime = this.runtime(request.sessionId);
      if (request.content.some((part) => part.type !== "text")) {
        // codexhost Harness input is text-only; never drop attachments silently.
        throw new RpcError(
          "session/attachment-invalid",
          "This Harness accepts text input only. Remove the attachment and describe it in text, or reference the file by path.",
          { reason: "text-only" },
        );
      }
      const prompt: QueuedPrompt = {
        id: randomUUID(),
        requestId: request.requestId,
        content: request.content,
      };
      if (runtime.running) {
        if (request.mode === "steer") {
          await this.steer(runtime, prompt);
          return { accepted: true };
        }
        runtime.queue.push(prompt);
        this.publishQueue(runtime);
        return { accepted: true };
      }
      void this.startTurn(runtime, prompt).catch((error: unknown) => {
        console.error(`[session ${request.sessionId}] turn failed to start`, error);
      });
      return { accepted: true };
    });
    rpc.register("session/cancel", async (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      const runtime = this.runtime(sessionId);
      runtime.queue = [];
      this.publishQueue(runtime);
      await runtime.starting;
      if (runtime.harness !== undefined && runtime.turnId !== undefined) {
        const result = await runtime.harness.execute({
          type: "turn.cancel",
          turnId: runtime.turnId,
        });
        if (!result.ok) this.endTurn(runtime, { status: "cancelled" });
      } else if (runtime.running) {
        this.endTurn(runtime, { status: "cancelled" });
      }
      return { accepted: true };
    });
    rpc.register("session/updateQueue", (args) => {
      const request = requestOf<{
        sessionId: string;
        itemId: string;
        action: { kind: string; content?: Array<{ type: string; text?: string }> };
      }>(args);
      const runtime = this.runtime(request.sessionId);
      const index = runtime.queue.findIndex((item) => item.id === request.itemId);
      if (index < 0)
        throw new RpcError("session/queue-item-not-found", "Queued message not found", {
          itemId: request.itemId,
        });
      if (request.action.kind === "remove") runtime.queue.splice(index, 1);
      else if (request.action.kind === "edit" && request.action.content !== undefined)
        (runtime.queue[index] as QueuedPrompt).content = request.action.content;
      else if (request.action.kind === "steer") {
        const [item] = runtime.queue.splice(index, 1);
        void this.steer(runtime, item as QueuedPrompt);
        return { accepted: true };
      }
      this.publishQueue(runtime);
      return { accepted: true };
    });
    rpc.register("session/rename", (args) => {
      const request = requestOf<{ sessionId: string; title: string }>(args);
      const runtime = this.runtime(request.sessionId);
      const title = request.title.trim();
      if (title === "")
        throw new RpcError("session/title-invalid", "Title must not be empty", {
          sessionId: request.sessionId,
        });
      runtime.meta.title = title;
      this.saveMeta(runtime.meta);
      const event = runtime.log.append("session/title", {
        title,
        messageSeqs: [],
        source: { kind: "user" },
      });
      runtime.log.setProjection("title", title);
      return { title, seq: event.seq };
    });
    rpc.register(
      "session/fork",
      async (args) => await this.fork(requestOf<{ sessionId: string; atSeq?: number }>(args)),
    );
    rpc.register("session/search", (args) => {
      const { query } = requestOf<{ query: string }>(args);
      const needle = query.toLowerCase();
      const items = Object.values(this.index)
        .filter((meta) => (meta.title ?? "").toLowerCase().includes(needle))
        .slice(0, 20)
        .map((meta) => ({ sessionId: meta.sessionId, snippet: meta.title ?? "" }));
      return { items, hasMore: false };
    });
    rpc.register("session/page", (args) => {
      const request = requestOf<{
        address: { sessionId?: string; childSessionId?: string };
        throughSeq: number;
        beforeSeq?: number;
        maxMessages?: number;
        turnWindow?: { minMessages: number; minTurns: number };
      }>(args);
      const sessionId = request.address.sessionId ?? request.address.childSessionId ?? "";
      return this.runtime(sessionId).log.page(request.throughSeq, request.beforeSeq, {
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
        ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
      });
    });
    rpc.register("session/projections", (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      if (this.index[sessionId] === undefined) return null;
      return this.runtime(sessionId).log.projectionBaseline();
    });
    rpc.register("session/workspacePathApplications", () => ({ applications: [] }));
    rpc.register("session/openWorkspacePath", () => {
      throw new RpcError(
        "session/open-unavailable",
        "Opening host paths is not available from the Web UI",
        {},
      );
    });
    streams.register("session/follow", (args, sink) => {
      const request = requestOf<{
        address: { kind: string; sessionId?: string; childSessionId?: string };
        assistantStream?: boolean;
        maxMessages?: number;
        turnWindow?: { minMessages: number; minTurns: number };
      }>(args);
      const sessionId = request.address.sessionId ?? request.address.childSessionId ?? "";
      if (this.index[sessionId] === undefined) {
        sink.fail("session/not-found", `Unknown session ${sessionId}`);
        return;
      }
      const runtime = this.runtime(sessionId);
      const ready =
        runtime.meta.origin === "subagent" ? this.backfillChild(runtime) : this.backfill(runtime);
      void ready.finally(() => {
        if (!sink.closed) runtime.log.follow(sink, request);
      });
    });
    streams.register("session/control", (_args, sink) => {
      this.controlSinks.add(sink);
      sink.onClose(() => this.controlSinks.delete(sink));
      const projections: Record<string, unknown> = {};
      for (const [sessionId, runtime] of this.runtimes)
        projections[sessionId] = runtime.log.projectionBaseline();
      sink.push({ type: "baseline", value: { projections } });
    });
  }

  /** Harness bound to a session, or the catalog default for a session that has not started. */
  private async harnessIdOf(runtime: Runtime | undefined): Promise<string> {
    if (runtime?.meta.harnessId !== undefined) return runtime.meta.harnessId;
    if (runtime?.meta.selection !== undefined) return runtime.meta.selection.provider;
    return (await this.harnesses.modelCatalog()).default.provider;
  }

  /** Permission presets offered for a session's Harness. */
  async permissionCatalog(sessionId?: string): Promise<{
    options: Array<{ value: string; name: string }>;
    defaultOptions: Array<{ value: string; name: string }>;
    defaultPreset: string;
  }> {
    const runtime =
      sessionId === undefined || this.index[sessionId] === undefined
        ? undefined
        : this.runtime(sessionId);
    const harnessId = await this.harnessIdOf(runtime);
    const inspection = await this.harnesses.inspect(harnessId);
    const modes = inspection.status === "ready" ? inspection.permissionModes : undefined;
    const options = modes?.modes.map((mode) => ({ value: mode.id, name: mode.label })) ?? [
      { value: "default", name: "Default" },
    ];
    return { options, defaultOptions: options, defaultPreset: modes?.defaultModeId ?? "default" };
  }

  // ---- subagents ---------------------------------------------------------------------------

  private childId(parentSessionId: string, nativeSubagentId: string): string {
    return `${parentSessionId}~sub-${createHash("sha1").update(nativeSubagentId).digest("hex").slice(0, 12)}`;
  }

  private childOf(parent: Runtime, nativeSubagentId: string): Runtime | undefined {
    const id = this.childId(parent.meta.sessionId, nativeSubagentId);
    return this.index[id] === undefined ? undefined : this.runtime(id);
  }

  /** Mirror a delegation's subagents as child sessions listed in the parent's subagentCatalog. */
  private trackSubagents(
    parent: Runtime,
    subagents: ReadonlyArray<{
      subagentId: string;
      nativeSubagentId?: string;
      description: string;
      status: string;
    }>,
  ): void {
    let catalog =
      (parent.log.projections.subagentCatalog as Array<{ id: string }> | undefined) ?? [];
    let changed = false;
    for (const subagent of subagents) {
      const nativeId = subagent.nativeSubagentId;
      if (nativeId === undefined) continue;
      const id = this.childId(parent.meta.sessionId, nativeId);
      if (this.index[id] === undefined) {
        const now = Date.now();
        const meta: SessionMeta = {
          sessionId: id,
          cwd: parent.meta.cwd,
          createdAt: now,
          updatedAt: now,
          ...(parent.meta.harnessId === undefined ? {} : { harnessId: parent.meta.harnessId }),
          title: subagent.description.slice(0, 80) || "Subagent",
          blank: false,
          lastPromptAt: now,
          origin: "subagent",
          parentSessionId: parent.meta.sessionId,
          nativeSubagentId: nativeId,
          backfill: "pending",
        };
        this.saveMeta(meta);
        const child = this.runtime(id);
        child.log.setProjection("title", meta.title);
        this.events.emit("api-session/added", this.summary(meta));
      }
      if (!catalog.some((entry) => entry.id === id)) {
        catalog = [
          ...catalog,
          { id, createdAt: Date.now(), mode: "one-shot", label: subagent.description.slice(0, 80) },
        ] as typeof catalog;
        changed = true;
      }
      const child = this.runtime(id);
      this.setRunning(child, subagent.status === "running" || subagent.status === "pending");
      if (subagent.status !== "running" && subagent.status !== "pending") {
        child.meta.backfill = "pending";
        this.saveMeta(child.meta);
      }
    }
    if (changed) parent.log.setProjection("subagentCatalog", catalog);
  }

  /** Rebuild a child session's journal from the Harness's subagent transcript. */
  private async backfillChild(child: Runtime): Promise<void> {
    const { meta } = child;
    if (
      meta.backfill !== "pending" ||
      meta.parentSessionId === undefined ||
      meta.nativeSubagentId === undefined
    )
      return;
    const parent = this.index[meta.parentSessionId];
    child.backfilling ??= (async () => {
      try {
        const adapter = (await this.harnesses.adapter(meta.harnessId ?? "")) as unknown as {
          subagents?: {
            readSnapshot(input: {
              parent: unknown;
              nativeSubagentId: string;
              cwd: string;
            }): Promise<
              { ok: true; value: { turns: unknown[] } } | { ok: false; error: { message: string } }
            >;
          };
        };
        if (adapter.subagents === undefined || parent?.nativeRef === undefined)
          throw new Error("This Harness does not expose subagent transcripts");
        const snapshot = await adapter.subagents.readSnapshot({
          parent: parent.nativeRef,
          nativeSubagentId: meta.nativeSubagentId as string,
          cwd: meta.cwd,
        });
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        child.log.reset();
        this.replayTurns(child, snapshot.value.turns);
        meta.backfill = "done";
        this.saveMeta(meta);
        this.updateStats(child);
      } catch (error) {
        child.log.reset();
        child.log.append(
          "codexhost/notice",
          {
            level: "error",
            message: `Could not load the subagent transcript: ${error instanceof Error ? error.message : String(error)}`,
          },
          { ignorable: true },
        );
        meta.backfill = "failed";
        this.saveMeta(meta);
      } finally {
        child.backfilling = undefined;
      }
    })();
    await child.backfilling;
  }

  // ---- native session import ---------------------------------------------------------------

  /** Existing Native Sessions a Harness can hand over, newest first. */
  async importCandidates(
    harnessId: string,
    query?: string,
  ): Promise<
    Array<{
      harnessId: string;
      nativeSessionId: string;
      title: string | null;
      cwd: string;
      updatedAt: number;
      imported?: string;
    }>
  > {
    const adapter = (await this.harnesses.adapter(harnessId)) as unknown as {
      sessionImport?: {
        listCandidates(): Promise<
          | {
              ok: true;
              value: Array<{
                nativeSessionId: string;
                title: string | null;
                cwd: string;
                updatedAt: number;
              }>;
            }
          | { ok: false; error: { message: string } }
        >;
      };
    };
    if (adapter.sessionImport === undefined) return [];
    const result = await adapter.sessionImport.listCandidates();
    if (!result.ok) throw new RpcError("import/unavailable", result.error.message, { harnessId });
    const needle = query?.trim().toLowerCase();
    const importedBy = new Map<string, string>();
    for (const meta of Object.values(this.index)) {
      if (meta.harnessId === harnessId && meta.nativeSessionId !== undefined)
        importedBy.set(meta.nativeSessionId, meta.sessionId);
    }
    return result.value
      .filter(
        (candidate) =>
          needle === undefined ||
          needle === "" ||
          (candidate.title ?? "").toLowerCase().includes(needle) ||
          candidate.cwd.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((candidate) => ({
        harnessId,
        nativeSessionId: candidate.nativeSessionId,
        title: candidate.title,
        cwd: candidate.cwd,
        updatedAt: candidate.updatedAt,
        ...(importedBy.has(candidate.nativeSessionId)
          ? { imported: importedBy.get(candidate.nativeSessionId) as string }
          : {}),
      }));
  }

  /** Map one Native Session into a Web Session (idempotent per Harness + native id). */
  async importNative(
    harnessId: string,
    nativeSessionId: string,
  ): Promise<{ sessionId: string; created: boolean }> {
    const existing = Object.values(this.index).find(
      (meta) => meta.harnessId === harnessId && meta.nativeSessionId === nativeSessionId,
    );
    if (existing !== undefined) return { sessionId: existing.sessionId, created: false };
    const adapter = (await this.harnesses.adapter(harnessId)) as unknown as {
      sessionImport?: {
        resolveCandidate?(id: string): Promise<
          | {
              ok: true;
              value: {
                candidate: { title: string | null; cwd: string; updatedAt: number };
                nativeRef: unknown;
              };
            }
          | { ok: false; error: { message: string } }
        >;
      };
    };
    const resolve = adapter.sessionImport?.resolveCandidate;
    if (resolve === undefined)
      throw new RpcError("import/unsupported", `${harnessId} cannot import native sessions`, {
        harnessId,
      });
    const result = await resolve.call(adapter.sessionImport, nativeSessionId);
    if (!result.ok)
      throw new RpcError("import/unavailable", result.error.message, {
        harnessId,
        nativeSessionId,
      });
    const { candidate, nativeRef } = result.value;
    const sessionId = `session-${randomUUID()}`;
    const title = candidate.title?.trim() || "Imported session";
    const meta: SessionMeta = {
      sessionId,
      cwd: candidate.cwd,
      createdAt: candidate.updatedAt,
      updatedAt: Date.now(),
      harnessId,
      nativeRef,
      nativeSessionId,
      title,
      blank: false,
      lastPromptAt: candidate.updatedAt,
      backfill: "pending",
    };
    this.saveMeta(meta);
    this.workspaces.attachSession(sessionId, undefined, candidate.cwd);
    const runtime = this.runtime(sessionId);
    runtime.log.setProjection("title", title);
    runtime.log.setProjection("sessionListMetadata", {
      blank: false,
      lastPromptAt: candidate.updatedAt,
    });
    this.events.emit("api-session/added", this.summary(runtime.meta));
    return { sessionId, created: true };
  }

  /** Project historical Harness turns into a journal (no presentation frames). */
  private replayTurns(runtime: Runtime, turns: unknown[]): void {
    try {
      let previousEnd = runtime.meta.createdAt;
      for (const turn of turns as Array<{
        input: Array<{ type: string; text?: string }>;
        items: Array<{ item: HostItem; outcome: HostItemOutcome }>;
        outcome: TurnOutcomeShape;
        model?: { id: string };
        startedAtMs?: number;
        completedAtMs?: number;
        checkpoint?: unknown;
      }>) {
        const start = turn.startedAtMs ?? previousEnd;
        const end = turn.completedAtMs ?? start;
        previousEnd = end;
        runtime.log.clock = () => start;
        const projector = new TurnProjector(runtime.log, {
          live: false,
          cwd: runtime.meta.cwd,
          ...(runtime.meta.harnessId === undefined
            ? {}
            : { model: { provider: runtime.meta.harnessId, model: turn.model?.id ?? "harness" } }),
        });
        projector.begin(turn.input, undefined);
        for (const { item, outcome } of turn.items) projector.itemCompleted(item, outcome);
        runtime.log.clock = () => end;
        projector.finish(turn.outcome);
        if (turn.checkpoint !== undefined)
          this.recordCheckpoint(runtime, projector.turn, turn.checkpoint);
        runtime.log.clock = undefined;
      }
    } finally {
      runtime.log.clock = undefined;
    }
  }

  /** Replay a Native Session's history into an empty journal (first open after import). */
  private async backfill(runtime: Runtime): Promise<void> {
    if (runtime.meta.backfill !== "pending") return;
    runtime.backfilling ??= (async () => {
      try {
        // Prefer a read-only history call when the Adapter offers one: it needs no writer role
        // and starts no native session.
        const adapter = (await this.harnesses.adapter(runtime.meta.harnessId ?? "")) as unknown as {
          readHistory?(
            nativeRef: unknown,
          ): Promise<
            { ok: true; value: { turns: unknown[] } } | { ok: false; error: { message: string } }
          >;
        };
        const snapshot =
          adapter.readHistory !== undefined && runtime.meta.nativeRef !== undefined
            ? await adapter.readHistory(runtime.meta.nativeRef)
            : await (await this.harnessFor(runtime)).readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        if (runtime.log.events.some((event) => event.type === "turn/start")) return;
        this.replayTurns(runtime, snapshot.value.turns);
        runtime.meta.backfill = "done";
        this.saveMeta(runtime.meta);
        this.updateStats(runtime);
        // History-only opens release their native process quickly.
        this.scheduleIdleRelease(runtime, 15_000);
      } catch (error) {
        console.error(`[session ${runtime.meta.sessionId}] history backfill failed`, error);
        runtime.log.append(
          "codexhost/notice",
          {
            level: "error",
            message: `Could not load history: ${error instanceof Error ? error.message : String(error)}`,
          },
          { ignorable: true },
        );
        runtime.meta.backfill = "failed";
        this.saveMeta(runtime.meta);
      } finally {
        runtime.log.clock = undefined;
        runtime.backfilling = undefined;
      }
    })();
    await runtime.backfilling;
  }

  registerImport(rpc: RpcRegistry): void {
    rpc.register("codexhost/importSources", async () => {
      const sources: Array<{ harnessId: string; name: string }> = [];
      for (const harnessId of this.harnesses.ids()) {
        try {
          const adapter = (await this.harnesses.adapter(harnessId)) as unknown as {
            sessionImport?: unknown;
          };
          if (adapter.sessionImport !== undefined)
            sources.push({
              harnessId,
              name: this.harnesses.manifest(harnessId)?.name ?? harnessId,
            });
        } catch {
          // Unloadable plugins offer no import.
        }
      }
      return { sources };
    });
    rpc.register("codexhost/importCandidates", async (args) => {
      const request = requestOf<{ harnessId: string; query?: string; limit?: number }>(args);
      const all = await this.importCandidates(request.harnessId, request.query);
      return { items: all.slice(0, Math.min(request.limit ?? 50, 500)), total: all.length };
    });
    rpc.register("codexhost/import", async (args) => {
      const request = requestOf<{ harnessId: string; nativeSessionId: string }>(args);
      return await this.importNative(request.harnessId, request.nativeSessionId);
    });
  }

  /** Import the newest native sessions of every Harness that supports it. */
  async importRecent(limit: number): Promise<number> {
    let count = 0;
    for (const harnessId of this.harnesses.ids()) {
      try {
        const candidates = await this.importCandidates(harnessId);
        for (const candidate of candidates.slice(0, limit)) {
          if (candidate.imported !== undefined) continue;
          await this.importNative(harnessId, candidate.nativeSessionId);
          count += 1;
        }
      } catch (error) {
        console.error(`[import] ${harnessId}`, error instanceof Error ? error.message : error);
      }
    }
    return count;
  }

  // ---- fork --------------------------------------------------------------------------------

  private recordCheckpoint(runtime: Runtime, turn: number, checkpoint: unknown): void {
    runtime.meta.checkpoints = { ...(runtime.meta.checkpoints ?? {}), [String(turn)]: checkpoint };
    this.saveMeta(runtime.meta);
  }

  /**
   * Fork a session at a completed turn: the Harness derives a native session from that turn's
   * checkpoint, and the new Web session starts with the journal prefix through that turn.
   */
  async fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    const source = this.runtime(request.sessionId);
    const { meta } = source;
    const unavailable = (message: string): never => {
      throw new RpcError("session/fork-unavailable", message, { sessionId: request.sessionId });
    };
    if (meta.harnessId === undefined || meta.nativeRef === undefined)
      return unavailable("Send a message before forking this session.");
    if (source.running) unavailable("Wait for the current turn to finish before forking.");
    // The fork point is the last completed turn at or before atSeq.
    const events = source.log.events;
    const limit = request.atSeq ?? events.length - 1;
    let cut: { turn: number; seq: number } | undefined;
    for (const event of events) {
      if (event.seq > limit) break;
      if (event.type === "turn/end")
        cut = { turn: (event.data as { turn: number }).turn, seq: event.seq };
    }
    if (cut === undefined) return unavailable("There is no completed turn to fork from.");
    const checkpoint = meta.checkpoints?.[String(cut.turn)];
    if (checkpoint === undefined)
      return unavailable("This Harness did not report a fork point for that turn.");
    const adapter = await this.harnesses.adapter(meta.harnessId);
    const opened = await adapter.open({
      kind: "fork",
      sourceRef: meta.nativeRef,
      checkpoint,
      cwd: meta.cwd,
    });
    if (!opened.ok)
      throw new RpcError("session/fork-unavailable", opened.error.message, {
        sessionId: request.sessionId,
      });
    const sessionId = `session-${randomUUID()}`;
    const now = Date.now();
    const checkpoints: Record<string, unknown> = {};
    for (const [turn, value] of Object.entries(meta.checkpoints ?? {}))
      if (Number(turn) <= cut.turn) checkpoints[turn] = value;
    const forkMeta: SessionMeta = {
      sessionId,
      cwd: meta.cwd,
      createdAt: now,
      updatedAt: now,
      harnessId: meta.harnessId,
      ...(meta.selection === undefined ? {} : { selection: meta.selection }),
      ...(meta.lastUsed === undefined ? {} : { lastUsed: meta.lastUsed }),
      ...(meta.permissionModeId === undefined ? {} : { permissionModeId: meta.permissionModeId }),
      title: `Fork · ${(meta.title ?? "Session").replace(/^Fork · /u, "")}`,
      blank: false,
      lastPromptAt: now,
      checkpoints,
    };
    this.saveMeta(forkMeta);
    this.data.writeLines(`sessions/${sessionId}/events.jsonl`, events.slice(0, cut.seq + 1));
    this.workspaces.attachSession(
      sessionId,
      this.workspaces.ownerOf(meta.sessionId)?.workspaceId,
      meta.cwd,
    );
    const runtime = this.runtime(sessionId);
    runtime.log.setProjection("title", forkMeta.title);
    runtime.log.setProjection("sessionListMetadata", { blank: false, lastPromptAt: now });
    if (meta.lastUsed !== undefined)
      runtime.log.setProjection("modelSelection", {
        lastUsed: meta.lastUsed,
        next: meta.selection ?? meta.lastUsed,
      });
    const session = opened.value;
    runtime.harness = session;
    this.applyState(runtime, session.initialState);
    void this.pump(runtime, session);
    this.updateStats(runtime);
    this.scheduleIdleRelease(runtime);
    this.events.emit("api-session/added", this.summary(runtime.meta));
    return { sessionId };
  }

  // ---- slash commands ----------------------------------------------------------------------

  private async harnessCommands(runtime: Runtime): Promise<
    Array<{
      id: string;
      invocation: string;
      label: string;
      description?: string;
      argumentMode: "none" | "text";
    }>
  > {
    type Descriptor = {
      id: string;
      invocation: string;
      label: string;
      description?: string;
      argumentMode: "none" | "text";
    };
    const live = runtime.harness?.commands;
    if (live !== undefined) {
      try {
        const result = (await live.list()) as { ok: boolean; value?: { commands: Descriptor[] } };
        if (result.ok && result.value !== undefined) return result.value.commands;
      } catch {
        // Fall back to the static catalog.
      }
    }
    const adapter = await this.harnesses.adapter(await this.harnessIdOf(runtime));
    return (adapter.commandCatalog?.commands ?? []) as Descriptor[];
  }

  private async listCommands(sessionId: string): Promise<unknown[]> {
    const runtime = this.runtime(sessionId);
    const commands: unknown[] = [
      {
        definitionId: "@deepseek-ai/dsh-permission-presets",
        name: "permission",
        description: "Switch the Harness permission mode",
        input: { hint: "<mode>" },
      },
    ];
    const seen = new Set(["permission"]);
    for (const command of await this.harnessCommands(runtime)) {
      const name = command.invocation.replace(/^\//u, "").toLowerCase();
      if (seen.has(name) || !/^[a-z0-9][a-z0-9:._-]*$/u.test(name)) continue;
      seen.add(name);
      commands.push({
        definitionId: `codexhost:${command.id}`,
        name,
        description: command.description ?? command.label,
        ...(command.argumentMode === "text" ? { input: { hint: "<text>" } } : {}),
      });
    }
    return commands;
  }

  private async executeCommand(sessionId: string, line: string): Promise<unknown> {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(line.trim());
    if (match === null) return undefined;
    const name = (match[1] as string).toLowerCase();
    const argumentText = (match[2] ?? "").trim();
    const runtime = this.runtime(sessionId);
    const commandId = randomUUID();
    if (name === "permission") {
      const catalog = await this.permissionCatalog(sessionId);
      const mode = catalog.options.find(
        (option) =>
          option.value === argumentText || option.name.toLowerCase() === argumentText.toLowerCase(),
      );
      if (mode === undefined) {
        return {
          commandId,
          result: {
            kind: "error",
            text: `Unknown permission mode "${argumentText}". Available: ${catalog.options.map((option) => option.value).join(", ")}`,
          },
        };
      }
      if (runtime.harness !== undefined) {
        const result = await runtime.harness.execute({
          type: "permissionMode.select",
          permissionModeId: mode.value,
        });
        if (!result.ok) return { commandId, result: { kind: "error", text: result.error.message } };
      }
      runtime.meta.permissionModeId = mode.value;
      this.saveMeta(runtime.meta);
      runtime.log.setProjection("permissions", { currentValue: mode.value });
      runtime.log.append("command/run", {
        commandId,
        name,
        args: argumentText,
        source: { kind: "user" },
      });
      runtime.log.append("command/done", {
        commandId,
        kind: "success",
        text: `Permission mode: ${mode.name}`,
      });
      return { commandId, result: { kind: "success", text: `Permission mode: ${mode.name}` } };
    }
    const descriptor = (await this.harnessCommands(runtime)).find(
      (command) => command.invocation.replace(/^\//u, "").toLowerCase() === name,
    );
    if (descriptor === undefined) return undefined;
    if (runtime.running)
      return {
        commandId,
        result: {
          kind: "error",
          text: "Wait for the current turn to finish before running a command.",
        },
      };
    const session = await this.harnessFor(runtime);
    if (session.commands === undefined)
      return {
        commandId,
        result: { kind: "error", text: "This Harness does not accept commands." },
      };
    runtime.projector = this.newProjector(runtime);
    this.setRunning(runtime, true);
    runtime.projector.begin([{ type: "text", text: line.trim() }], undefined);
    const turnId = `turn-${randomUUID()}`;
    runtime.turnId = turnId;
    const result = await session.commands.execute({
      turnId,
      commandId: descriptor.id,
      ...(argumentText === "" ? {} : { arguments: { text: argumentText } }),
    });
    if (!result.ok) {
      this.endTurn(runtime, {
        status: "failed",
        error: { code: "commandFailed", message: result.error?.message ?? "Command failed" },
      });
      return {
        commandId,
        result: { kind: "error", text: result.error?.message ?? "Command failed" },
      };
    }
    return { commandId, result: { kind: "success" } };
  }

  registerCommands(rpc: RpcRegistry): void {
    rpc.register(
      "commands/list",
      async (args) => await this.listCommands(String(args.agentId ?? "")),
    );
    rpc.register(
      "commands/execute",
      async (args) =>
        await this.executeCommand(String(args.agentId ?? ""), String(args.line ?? "")),
    );
    rpc.register(
      "permissionPresets/catalog",
      async (args) =>
        await this.permissionCatalog(
          typeof args.sessionId === "string" ? args.sessionId : undefined,
        ),
    );
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) {
      // Drop queued prompts first: endTurn would otherwise start the next one.
      runtime.queue = [];
      if (runtime.running) this.endTurn(runtime, { status: "unknown", reason: "server shutdown" });
    }
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          await runtime.harness?.close();
        } catch {
          // Best effort.
        }
      }),
    );
  }
}
