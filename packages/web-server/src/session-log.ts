/**
 * One Session's DSH-shaped event journal.
 *
 * The DSH Web client consumes an append-only, densely sequenced event log plus process-local
 * assistant presentation frames. This class owns that journal for one codexhost Session:
 * persistence (JSONL), live follower fan-out, the assistant-stream revision counter, and the
 * projection values the client reads from `session/control` and list rows.
 */

import type { DataDir } from "./store.ts";
import type { StreamSink } from "./transport.ts";

export interface WireEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
  ignorable?: true;
}

export interface SessionHeader {
  version: 4;
  id: string;
  createdAt: number;
  cwd?: string;
  isSeeded: false;
  agentPreset?: string;
}

export interface ActiveAttempt {
  attemptId: string;
  startedAfterSeq: number;
  turn: number;
  step: number;
  nextIndex: number;
  stream: Array<{ type: "chunk"; time: number; chunk: unknown }>;
}

/** Window sizing carried by follow and page requests. */
export interface PageWindow {
  maxMessages?: number;
  turnWindow?: { minMessages: number; minTurns: number };
}

export type ProjectionListener = (
  sessionId: string,
  key: string,
  value: unknown,
  seq: number,
) => void;

export function defaultProjections(): Record<string, unknown> {
  return {
    title: null,
    goal: null,
    tokenUsage: {
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    contextPressure: {},
    contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    agentPreset: "standard",
    subagentCatalog: [],
    subagentTiming: { settledMs: 0 },
    subagent: null,
    inbox: { "next-turn": [], "next-step": [] },
    turnOutline: [],
    userQuestions: { active: [], settled: [] },
    permissions: { currentValue: "default" },
    sessionStats: {
      turns: 0,
      steps: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
    },
    todos: null,
    plan: { active: false, pending: false },
    modelSelection: { lastUsed: null, next: null },
    sessionListMetadata: { blank: true, lastPromptAt: null },
    imageLimits: {
      maxImageBytes: 20971520,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 209715200,
      maxImagePixels: 64000000,
      maxImageDimension: 8192,
      mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    },
  };
}

export class SessionLog {
  readonly events: WireEvent[];
  readonly projections: Record<string, unknown>;
  private readonly followers = new Set<StreamSink>();
  private revision = 0;
  private attempt: ActiveAttempt | undefined;
  private attemptCounter = 0;
  /** Replay clock: while set, appended events take historical timestamps. */
  clock: (() => number) | undefined;

  constructor(
    readonly header: SessionHeader,
    private readonly data: Pick<
      DataDir,
      "readLines" | "readJson" | "writeLines" | "writeJson" | "appendLine"
    >,
    private readonly onProjection: ProjectionListener,
    private sequenceStart = 0,
    private readonly hasEarlier: () => boolean = () => false,
  ) {
    this.events = data.readLines<WireEvent>(this.file);
    this.projections = {
      ...defaultProjections(),
      ...data.readJson<Record<string, unknown>>(this.projectionFile, {}),
    };
    this.attemptCounter = this.events.filter((event) => event.type === "assistant/message").length;
  }

  /** Drop every event (rebuild from a fresh native transcript); projections are kept. */
  reset(): void {
    this.events.length = 0;
    this.data.writeLines(this.file, []);
    this.attempt = undefined;
  }

  /**
   * Close a Turn the previous server process left open (crash or restart mid-turn), using DSH's
   * `interrupted` reason so the client stops showing it as running.
   * @returns whether anything was appended.
   */
  closeOrphanedTurn(): boolean {
    let openTurn: number | undefined;
    let openStep: { turn: number; step: number } | undefined;
    for (const event of this.events) {
      const data = event.data as { turn?: number; step?: number };
      if (event.type === "turn/start") openTurn = data.turn;
      else if (event.type === "turn/end") openTurn = undefined;
      else if (event.type === "step/start")
        openStep = { turn: data.turn ?? 0, step: data.step ?? 0 };
      else if (event.type === "step/end") openStep = undefined;
    }
    if (openTurn === undefined && openStep === undefined) return false;
    if (openStep !== undefined) this.append("step/end", openStep);
    if (openTurn !== undefined)
      this.append("turn/end", { turn: openTurn, reason: { kind: "interrupted" } });
    return true;
  }

  private get file(): string {
    return `sessions/${this.header.id}/events.jsonl`;
  }

  private get projectionFile(): string {
    return `sessions/${this.header.id}/projections.json`;
  }

  get lastSeq(): number {
    return this.sequenceStart + this.events.length - 1;
  }

  get firstSeq(): number {
    return this.sequenceStart;
  }

  /** Prepend an already projected, completed page in a disposable journal only.
   * Existing event/message identities and live cursors must never be renumbered.
   */
  prepend(events: readonly WireEvent[]): void {
    if (!events.length) return;
    const start = this.sequenceStart - events.length;
    if (start < 0) throw new Error("History rendering sequence range exhausted");
    const shift = start - (events[0]?.seq ?? 0);
    const mapped = events.map((event) => ({
      ...event,
      seq: event.seq + shift,
      ...(event.sourceEventSeqs
        ? { sourceEventSeqs: event.sourceEventSeqs.map((seq) => seq + shift) }
        : {}),
    }));
    this.events.unshift(...mapped);
    this.sequenceStart = start;
  }

  /** Append one durable event and deliver it to followers. */
  append(
    type: string,
    data: unknown,
    extra: Pick<WireEvent, "surfaceOp" | "sourceEventSeqs" | "ignorable"> = {},
    time?: number,
  ): WireEvent {
    const event: WireEvent = {
      type,
      seq: this.sequenceStart + this.events.length,
      time: time ?? this.clock?.() ?? Date.now(),
      data,
      ...extra,
    };
    this.events.push(event);
    this.data.appendLine(this.file, event);
    for (const sink of this.followers) sink.push({ type: "event", event });
    return event;
  }

  setProjection(key: string, value: unknown): void {
    this.projections[key] = value;
    this.data.writeJson(this.projectionFile, this.projections);
    this.onProjection(this.header.id, key, value, Math.max(this.lastSeq, 0));
  }

  projectionBaseline(): { asOfSeq: number; values: Record<string, unknown> } {
    return { asOfSeq: Math.max(this.lastSeq, 0), values: this.projections };
  }

  // ---- assistant presentation stream -------------------------------------------------------

  get activeAttempt(): ActiveAttempt | undefined {
    return this.attempt;
  }

  startAttempt(turn: number, step: number): ActiveAttempt {
    this.attemptCounter += 1;
    const attempt: ActiveAttempt = {
      attemptId: `${this.header.id}:${String(this.attemptCounter)}`,
      startedAfterSeq: this.lastSeq,
      turn,
      step,
      nextIndex: 0,
      stream: [],
    };
    this.attempt = attempt;
    this.revision += 1;
    this.pushStream({
      type: "start",
      attemptId: attempt.attemptId,
      revision: this.revision,
      startedAfterSeq: attempt.startedAfterSeq,
      turn,
      step,
    });
    return attempt;
  }

  chunk(chunk: unknown): void {
    const attempt = this.attempt;
    if (attempt === undefined) return;
    const time = Date.now();
    attempt.stream.push({ type: "chunk", time, chunk });
    this.revision += 1;
    this.pushStream({
      type: "chunk",
      attemptId: attempt.attemptId,
      revision: this.revision,
      index: attempt.nextIndex,
      time,
      chunk,
    });
    attempt.nextIndex += 1;
  }

  /** Close the active attempt, either committed as the given event or abandoned. */
  endAttempt(committed: WireEvent | undefined): void {
    const attempt = this.attempt;
    if (attempt === undefined) return;
    this.attempt = undefined;
    this.revision += 1;
    this.pushStream({
      type: "end",
      attemptId: attempt.attemptId,
      revision: this.revision,
      index: attempt.nextIndex,
      outcome:
        committed === undefined
          ? { kind: "abandoned" }
          : { kind: "committed", eventType: committed.type, seq: committed.seq },
    });
  }

  private pushStream(frame: unknown): void {
    for (const sink of this.followers) sink.push({ type: "assistant-stream", frame });
  }

  // ---- followers ---------------------------------------------------------------------------

  follow(sink: StreamSink, request: PageWindow & { assistantStream?: boolean }): void {
    this.followers.add(sink);
    sink.onClose(() => this.followers.delete(sink));
    const attempt = this.attempt;
    const window = this.window(this.events.length, request);
    sink.push({
      type: "snapshot",
      header: this.header,
      cursor: this.lastSeq,
      records: this.events
        .slice(window.start, this.events.length)
        .map((event) => ({ type: "event", event })),
      hasMore: window.start > 0 || this.hasEarlier(),
      projections: this.projectionBaseline(),
      ...(request.assistantStream === true
        ? {
            assistantStream: {
              revision: this.revision,
              ...(attempt === undefined
                ? {}
                : {
                    activeAttempt: {
                      attemptId: attempt.attemptId,
                      startedAfterSeq: attempt.startedAfterSeq,
                      turn: attempt.turn,
                      step: attempt.step,
                      nextIndex: attempt.nextIndex,
                      stream: attempt.stream,
                    },
                  }),
            },
          }
        : {}),
    });
  }

  /**
   * Choose where a backwards window starts. Walks back from `end` counting append-origin
   * user/assistant messages and Turn starts; stops at a Turn start once both turn-window minima
   * hold, or as soon as `maxMessages` messages are included.
   */
  private window(end: number, request: PageWindow): { start: number } {
    const maxMessages = request.maxMessages ?? 500;
    const minMessages = request.turnWindow?.minMessages ?? maxMessages;
    const minTurns = request.turnWindow?.minTurns ?? Number.POSITIVE_INFINITY;
    let messages = 0;
    let turns = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
      const event = this.events[index] as WireEvent;
      if (
        (event.type === "user/message" || event.type === "assistant/message") &&
        event.surfaceOp === "append"
      )
        messages += 1;
      if (event.type === "turn/start") {
        turns += 1;
        if (messages >= minMessages && turns >= minTurns) return { start: index };
      }
      if (messages >= maxMessages) {
        // Prefer the enclosing Turn start so a window never opens mid-Turn.
        for (let back = index; back >= 0; back -= 1) {
          if ((this.events[back] as WireEvent).type === "turn/start") return { start: back };
        }
        return { start: index };
      }
    }
    return { start: 0 };
  }

  /** Backwards page ending before `beforeSeq` (inclusive cut at `throughSeq`). */
  page(
    throughSeq: number,
    beforeSeq: number | undefined,
    request: PageWindow = {},
  ): { records: unknown[]; hasMore: boolean } {
    const end = Math.max(
      0,
      Math.min(
        (beforeSeq ?? throughSeq + 1) - this.sequenceStart,
        throughSeq + 1 - this.sequenceStart,
        this.events.length,
      ),
    );
    const { start } = this.window(end, request);
    return {
      records: this.events.slice(start, end).map((event) => ({ type: "event", event })),
      hasMore: start > 0 || this.hasEarlier(),
    };
  }
}
