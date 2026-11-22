import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { HostTurnId } from "@codexhost/shared-contracts";

import {
  parseHostUsage,
  parseHostUsageRequest,
  type HostUsage,
  type HostUsageRequest,
  type HostUsageRequestTiming,
} from "@codexhost/harness-adapter";

import type { AntigravityPromptUsage } from "./acp-types.js";
import {
  readAntigravityRequestMetadata,
  type AntigravityRequestMetadata,
} from "./native-request-timing.js";

export interface AntigravitySessionUsageTrackerOptions {
  nativeSessionId: string;
  homedir: string;
  expectedInitialTurns?: number;
}

export function normalizeAntigravityUsageModel(rawModel: unknown): {
  model?: string;
  provider?: string;
} {
  if (typeof rawModel !== "string" || !rawModel.trim()) return {};
  const model = rawModel.trim();
  if (model.startsWith("claude-")) {
    return {
      model: model.replace(/(?:-thinking)?(?:-(?:low|medium|high|xhigh))?$/u, ""),
      provider: "anthropic",
    };
  }
  const baseModel = model.replace(/-(?:low|medium|high|xhigh)$/u, "");
  if (model.startsWith("gemini-")) return { model: baseModel, provider: "google" };
  if (model.startsWith("gpt-")) {
    return { model: baseModel, ...(!model.startsWith("gpt-oss-") ? { provider: "openai" } : {}) };
  }
  return { model };
}

export function hasImplicitZeroCacheWrite(identity: {
  model?: string;
  provider?: string;
}): boolean {
  return identity.provider === "google" || Boolean(identity.model?.startsWith("gpt-"));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function promptUsage(raw: AntigravityPromptUsage | undefined): HostUsage | null {
  if (!raw) return null;
  const usage: HostUsage = {};
  if (count(raw.inputTokens)) {
    usage.inputTokens =
      raw.inputTokens +
      (count(raw.cachedReadTokens) ? raw.cachedReadTokens : 0) +
      (count(raw.cachedWriteTokens) ? raw.cachedWriteTokens : 0);
  }
  if (count(raw.cachedReadTokens)) usage.cachedInputTokens = raw.cachedReadTokens;
  if (count(raw.cachedWriteTokens)) usage.cacheWriteInputTokens = raw.cachedWriteTokens;
  if (count(raw.outputTokens)) {
    // Native ModelUsageStats.output_tokens already includes thinking_output_tokens.
    usage.outputTokens = raw.outputTokens;
  }
  if (count(raw.thoughtTokens)) usage.reasoningOutputTokens = raw.thoughtTokens;
  if (count(raw.totalTokens)) usage.totalTokens = raw.totalTokens;
  else if (usage.inputTokens !== undefined && usage.outputTokens !== undefined)
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  if (!Object.keys(usage).length) return null;
  try {
    return parseHostUsage(usage);
  } catch {
    return null;
  }
}

function timing(input: { firstOutputAtMs?: number; completedAtMs?: number }): {
  startedAtMs?: number;
  completedAtMs?: number;
} {
  const { firstOutputAtMs, completedAtMs } = input;
  return count(firstOutputAtMs) && count(completedAtMs) && completedAtMs >= firstOutputAtMs
    ? { startedAtMs: firstOutputAtMs, completedAtMs }
    : {};
}

function requestUsage(requests: readonly HostUsageRequest[]): HostUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const request of requests) {
    inputTokens += request.inputTokens;
    outputTokens += request.outputTokens;
  }
  const usage: HostUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
  for (const field of [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (requests.every((request) => request[field] !== undefined))
      usage[field] = requests.reduce((sum, request) => sum + (request[field] ?? 0), 0);
  }
  return parseHostUsage(usage);
}

function addUsage(left: HostUsage, right: HostUsage): HostUsage {
  const usage: HostUsage = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (left[field] !== undefined && right[field] !== undefined)
      usage[field] = left[field] + right[field];
  }
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined)
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return parseHostUsage(usage);
}

function usageMatches(actual: HostUsage, expected: HostUsage, exact: boolean): boolean {
  const compare = (value: number | undefined, target: number | undefined) =>
    target === undefined || (value !== undefined && (exact ? value === target : value >= target));
  return (
    compare(
      actual.inputTokens === undefined
        ? undefined
        : actual.inputTokens - (actual.cacheWriteInputTokens ?? 0),
      expected.inputTokens === undefined
        ? undefined
        : expected.inputTokens - (expected.cacheWriteInputTokens ?? 0),
    ) &&
    (["outputTokens", "cachedInputTokens", "cacheWriteInputTokens"] as const).every((field) =>
      compare(actual[field], expected[field]),
    )
  );
}

interface TranscriptRequests {
  steps: Map<number, HostUsageRequest | null>;
  toolCallSteps: Set<number>;
  complete: boolean;
  metadata: Map<number, AntigravityRequestMetadata> | null;
}
interface PendingUsage {
  base: HostUsage;
  usage: HostUsage;
  steps: Set<number>;
}

type TimingTurn = { startedAtMs: number; turnId?: HostTurnId };
type RequestTiming = HostUsageRequestTiming & { turnId?: HostTurnId };

export class AntigravitySessionUsageTracker {
  readonly #file: string;
  readonly #nativeSessionId: string;
  readonly #home: string;
  #timingTurn: TimingTurn = { startedAtMs: 0 };
  readonly #consumed = new Map<number, HostUsageRequest>();
  readonly #requests = new Map<number, HostUsageRequest>();
  readonly #expectedInitialTurns: number;
  #invalidated = false;
  #turnActive = false;
  #turnBase: HostUsage = requestUsage([]);
  #pending: PendingUsage | undefined;
  #context: HostUsage = {};
  #tokens: HostUsage = {};
  #outputTokensPerSecond?: number;
  #complete = true;
  readonly #turnCollectionSteps = new Set<number>();
  readonly #awaitingTiming = new Map<number, TimingTurn>();

  constructor(options: AntigravitySessionUsageTrackerOptions) {
    this.#nativeSessionId = options.nativeSessionId;
    this.#home = options.homedir;
    this.#expectedInitialTurns = options.expectedInitialTurns ?? 0;
    this.#file = path.join(
      options.homedir,
      ".gemini",
      "antigravity-cli",
      "brain",
      options.nativeSessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
  }

  currentUsage(): HostUsage | null {
    const recorded = [...this.#requests]
      .sort(([left], [right]) => left - right)
      .map(([, request]) => request);
    const tokens = this.#pending
      ? addUsage(this.#pending.base, this.#pending.usage)
      : recorded.length
        ? requestUsage(recorded)
        : this.#tokens;
    const usage: HostUsage = { ...tokens, ...this.#context };
    const latest = recorded.at(-1);
    if (latest?.cachedInputTokens !== undefined && latest.inputTokens > 0) {
      usage.cacheHitRatePercent = (latest.cachedInputTokens / latest.inputTokens) * 100;
    }
    if (this.#outputTokensPerSecond !== undefined) {
      usage.outputTokensPerSecond = this.#outputTokensPerSecond;
    }
    if (
      this.#historyComplete() &&
      recorded.length > 0 &&
      recorded.every((request) => request.cachedInputTokens !== undefined)
    ) {
      usage.sessionCacheUsage = {
        inputTokens: recorded.reduce((sum, request) => sum + request.inputTokens, 0),
        cachedInputTokens: recorded.reduce(
          (sum, request) => sum + (request.cachedInputTokens ?? 0),
          0,
        ),
      };
    }
    return Object.keys(usage).length ? parseHostUsage(usage) : null;
  }

  recordContextWindow(used: number, size: number): HostUsage | null {
    if (count(used) && count(size) && size > 0) {
      this.#context = {
        contextUsedTokens: used,
        contextWindowTokens: size,
        contextUsagePercent: Math.min(100, (used / size) * 100),
      };
    }
    return this.currentUsage();
  }

  beginTurn(startedAtMs = Date.now(), turnId?: HostTurnId): void {
    this.#timingTurn = { startedAtMs, ...(turnId && { turnId }) };
    this.#turnBase = this.#pending
      ? addUsage(this.#pending.base, this.#pending.usage)
      : requestUsage([...this.#requests.values()]);
    this.#turnCollectionSteps.clear();
    this.#turnActive = true;
  }

  endTurn(): void {
    this.#turnActive = false;
  }

  #historyComplete(): boolean {
    // Completeness covers finished requests, not whether the Turn is still running.
    return this.#complete && !this.#invalidated && !this.#pending;
  }

  #reconcile(): void {
    // Cancellation can add native requests without PromptResponse usage; the target is a lower bound.
    if (
      this.#pending &&
      usageMatches(
        requestUsage([...this.#requests.values()]),
        addUsage(this.#pending.base, this.#pending.usage),
        false,
      )
    )
      this.#pending = undefined;
  }

  recordTurnPromptUsage(input: {
    usage?: AntigravityPromptUsage;
    firstOutputAtMs?: number;
    completedAtMs?: number;
  }): { usage: HostUsage | null; complete: boolean } {
    this.endTurn();
    const usage = promptUsage(input.usage);
    if (usage) {
      if (this.#requests.size === 0) this.#tokens = usage;
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        this.#pending = {
          base: this.#pending?.base ?? this.#turnBase,
          usage: this.#pending ? addUsage(this.#pending.usage, usage) : usage,
          steps: new Set([...(this.#pending?.steps ?? []), ...this.#turnCollectionSteps]),
        };
        this.#reconcile();
      }
    }
    return { usage: this.currentUsage(), complete: this.#historyComplete() };
  }

  async replayHistoricalRequests(signal?: AbortSignal): Promise<{
    requests: HostUsageRequest[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    const transcript = await this.#read(signal);
    const { requests } = this.#consume(transcript, true);
    this.#reconcile();
    return { requests, complete: this.#historyComplete(), usage: this.currentUsage() };
  }

  async collectNewTranscriptRequests(
    input: {
      firstOutputAtMs?: number;
      completedAtMs?: number;
      promptUsage?: AntigravityPromptUsage;
      hasToolCalls?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    requests: HostUsageRequest[];
    timings: RequestTiming[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    const transcript = await this.#read(input.signal);
    for (const step of transcript.steps.keys()) {
      if (!this.#consumed.has(step)) {
        this.#turnCollectionSteps.add(step);
        this.#pending?.steps.add(step);
      }
    }
    const usage = promptUsage(input.promptUsage);
    const hadPending = this.#pending !== undefined;
    const cacheUsage =
      usage && this.#pending
        ? addUsage(this.#pending.usage, usage)
        : (usage ?? this.#pending?.usage);
    const { requests, timings } = this.#consume(transcript, false, cacheUsage);
    // A whole-Prompt interval can only describe one request, including one published earlier.
    const [step] = this.#turnCollectionSteps;
    if (
      step !== undefined &&
      this.#turnCollectionSteps.size === 1 &&
      !hadPending &&
      !input.hasToolCalls &&
      !transcript.toolCallSteps.has(step) &&
      transcript.metadata === null &&
      transcript.complete &&
      !this.#invalidated &&
      usage?.inputTokens !== undefined &&
      usage.outputTokens !== undefined
    ) {
      const single = this.#requests.get(step);
      const { startedAtMs, completedAtMs } = timing(input);
      if (
        single &&
        single.startedAtMs === undefined &&
        (single.reasoningOutputTokens ?? usage.reasoningOutputTokens) === 0 &&
        (usage.reasoningOutputTokens ?? 0) === 0 &&
        usageMatches(requestUsage([single]), usage, true) &&
        startedAtMs !== undefined &&
        completedAtMs !== undefined
      ) {
        const updated = parseHostUsageRequest({ ...single, startedAtMs, completedAtMs });
        const index = requests.indexOf(single);
        if (index !== -1) requests[index] = updated;
        else if (completedAtMs > startedAtMs && single.outputTokens > 0)
          timings.push({
            ...this.#timingIdentity(single, this.#timingTurn),
            output: { startedAtMs, completedAtMs, outputTokens: single.outputTokens },
          });
        this.#requests.set(step, updated);
      }
    }
    this.#recordTurnOutputSpeed();
    this.#reconcile();
    return { requests, timings, complete: this.#historyComplete(), usage: this.currentUsage() };
  }

  #recordTurnOutputSpeed(): void {
    let tokens = 0;
    let milliseconds = 0;
    for (const step of this.#turnCollectionSteps) {
      const request = this.#requests.get(step);
      if (
        request?.startedAtMs === undefined ||
        request.completedAtMs === undefined ||
        request.completedAtMs <= request.startedAtMs ||
        request.outputTokens <= 0
      )
        continue;
      tokens += request.timedOutputTokens ?? request.outputTokens;
      milliseconds += request.completedAtMs - request.startedAtMs;
    }
    if (milliseconds > 0) this.#outputTokensPerSecond = tokens / (milliseconds / 1000);
  }

  #consume(
    transcript: TranscriptRequests,
    historical: boolean,
    cacheUsage?: HostUsage | null,
  ): { requests: HostUsageRequest[]; timings: RequestTiming[] } {
    this.#complete = transcript.complete;
    const requests: HostUsageRequest[] = [];
    const timings: RequestTiming[] = [];
    const steps = new Set([...(this.#pending?.steps ?? []), ...this.#turnCollectionSteps]);
    for (const [step, request] of transcript.steps) {
      if (!request) continue;
      const previous = this.#consumed.get(step);
      if (previous) {
        if (
          (
            [
              "model",
              "provider",
              "inputTokens",
              "outputTokens",
              "cachedInputTokens",
              "cacheWriteInputTokens",
              "reasoningOutputTokens",
            ] as const
          ).some((field) => previous[field] !== request[field])
        ) {
          this.#invalidated = true;
          this.#awaitingTiming.delete(step);
        }
        const recorded = this.#requests.get(step);
        const turn = this.#awaitingTiming.get(step);
        if (!historical && recorded && turn)
          this.#requests.set(
            step,
            this.#applyTiming(transcript, step, recorded, timings, turn, true),
          );
        continue;
      }
      const write = cacheUsage?.cacheWriteInputTokens;
      const singleMatches =
        steps.size === 1 &&
        cacheUsage?.inputTokens !== undefined &&
        request.inputTokens - (request.cacheWriteInputTokens ?? 0) ===
          cacheUsage.inputTokens - (write ?? 0) &&
        request.outputTokens === cacheUsage.outputTokens &&
        (cacheUsage.cachedInputTokens === undefined ||
          request.cachedInputTokens === cacheUsage.cachedInputTokens);
      const native = transcript.metadata?.get(step);
      // A prompt aggregate is a request fact only when exactly one matching request is known.
      const thought =
        !historical && singleMatches && transcript.complete
          ? (cacheUsage?.reasoningOutputTokens ?? native?.reasoningOutputTokens)
          : native?.reasoningOutputTokens;
      let parsed = parseHostUsageRequest({
        ...request,
        ...(thought !== undefined && thought <= request.outputTokens
          ? { reasoningOutputTokens: thought }
          : {}),
      });
      if (
        !historical &&
        request.cachedInputTokens !== undefined &&
        request.cacheWriteInputTokens === undefined
      ) {
        if (write === 0 || (write !== undefined && singleMatches && transcript.complete))
          parsed = parseHostUsageRequest({
            ...parsed,
            inputTokens: request.inputTokens + (write ?? 0),
            cacheWriteInputTokens: write,
          });
      }
      if (
        !historical &&
        parsed.cacheWriteInputTokens === undefined &&
        (this.#turnActive || this.#pending?.steps.has(step))
      ) {
        this.#complete = false;
        continue;
      }
      const turn = historical ? undefined : this.#timingTurn;
      if (turn) this.#awaitingTiming.set(step, turn);
      else parsed.historical = true;
      const timed = this.#applyTiming(transcript, step, parsed, timings, turn);
      this.#consumed.set(step, request);
      this.#requests.set(step, timed);
      // Idle catch-up must use the tagged timing event, not the Host's active Turn.
      requests.push(historical || this.#turnActive ? timed : parsed);
    }
    return { requests, timings };
  }

  #timingIdentity(request: HostUsageRequest, turn: TimingTurn) {
    return { requestId: request.requestId, ...(turn.turnId && { turnId: turn.turnId }) };
  }

  #applyTiming(
    transcript: TranscriptRequests,
    step: number,
    request: HostUsageRequest,
    timings: RequestTiming[],
    turn: TimingTurn | undefined,
    late = false,
  ): HostUsageRequest {
    const native = transcript.metadata?.get(step);
    if (!native?.timing || native.timing.completedAtMs > Date.now()) return request;
    this.#awaitingTiming.delete(step);
    const { requestStartedAtMs, timeToFirstOutputMs, startedAtMs, completedAtMs } = native.timing;
    const thought = request.reasoningOutputTokens ?? native.reasoningOutputTokens;
    if ((turn && requestStartedAtMs < turn.startedAtMs) || thought !== native.reasoningOutputTokens)
      return request;
    // An assembled tool payload or a thinking-only request has no reliable text generation window.
    const interval =
      request.startedAtMs === undefined &&
      thought < request.outputTokens &&
      !transcript.toolCallSteps.has(step) &&
      completedAtMs > startedAtMs
        ? { startedAtMs, completedAtMs, outputTokens: request.outputTokens - thought }
        : undefined;
    const separateOutput = late || !this.#turnActive;
    if (turn)
      timings.push({
        ...this.#timingIdentity(request, turn),
        requestStartedAtMs,
        timeToFirstOutputMs,
        ...(separateOutput && interval ? { output: interval } : {}),
      });
    return parseHostUsageRequest({
      ...request,
      reasoningOutputTokens: thought,
      ...(interval ? { startedAtMs, completedAtMs, timedOutputTokens: interval.outputTokens } : {}),
    });
  }

  async #read(signal?: AbortSignal): Promise<TranscriptRequests> {
    signal?.throwIfAborted();
    const stream = createReadStream(this.#file, { encoding: "utf8", signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const result: TranscriptRequests = {
      steps: new Map(),
      toolCallSteps: new Set(),
      complete: true,
      metadata: null,
    };
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line);
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
        } catch {
          result.complete = false;
          continue;
        }
        if (record.type !== "PLANNER_RESPONSE") continue;
        if (!count(record.step_index)) {
          result.complete = false;
          continue;
        }
        let request: HostUsageRequest | null = null;
        try {
          if (record.status !== "DONE" && record.status !== "ERROR") throw new Error();
          const identity = normalizeAntigravityUsageModel(record.model);
          const cacheRead = count(record.cache_read_tokens) ? record.cache_read_tokens : undefined;
          const cacheWrite = count(record.cache_write_tokens)
            ? record.cache_write_tokens
            : cacheRead !== undefined && hasImplicitZeroCacheWrite(identity)
              ? 0
              : undefined;
          request = parseHostUsageRequest({
            requestId: `step:${record.step_index}`,
            ...identity,
            inputTokens: count(record.input_tokens)
              ? record.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
              : undefined,
            ...(record.cache_read_tokens !== undefined
              ? { cachedInputTokens: record.cache_read_tokens }
              : {}),
            ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
            outputTokens: record.output_tokens,
          });
        } catch {
          // The latest version of a step is authoritative, even when it lacks usage.
        }
        result.steps.set(record.step_index, request);
        if (
          record.tool_calls !== undefined &&
          (!Array.isArray(record.tool_calls) || record.tool_calls.length > 0)
        )
          result.toolCallSteps.add(record.step_index);
        else result.toolCallSteps.delete(record.step_index);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.#expectedInitialTurns > 0)
        result.complete = false;
    } finally {
      lines.close();
      stream.destroy();
    }
    result.complete &&=
      [...result.steps.values()].every((request) => request !== null) &&
      [...this.#consumed.keys()].every((step) => result.steps.has(step));
    const needed = new Set(this.#awaitingTiming.keys());
    for (const step of result.steps.keys()) if (!this.#consumed.has(step)) needed.add(step);
    if (needed.size > 0)
      result.metadata = await readAntigravityRequestMetadata(
        this.#nativeSessionId,
        this.#home,
        result.steps,
        needed,
      );
    signal?.throwIfAborted();
    return result;
  }
}
