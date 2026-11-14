import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  parseHostUsage,
  parseHostUsageRequest,
  type HostUsage,
  type HostUsageRequest,
} from "@codexhost/harness-adapter";

import type { AntigravityPromptUsage } from "./acp-types.js";

export interface AntigravitySessionUsageTrackerOptions {
  nativeSessionId: string;
  homedir: string;
  initialContextUsedTokens?: number;
  initialContextWindowTokens?: number;
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
    usage.outputTokens = raw.outputTokens + (count(raw.thoughtTokens) ? raw.thoughtTokens : 0);
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
  const usage: HostUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const request of requests) {
    usage.inputTokens! += request.inputTokens;
    usage.outputTokens! += request.outputTokens;
  }
  usage.totalTokens = usage.inputTokens! + usage.outputTokens!;
  for (const field of [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (requests.every((request) => request[field] !== undefined))
      usage[field] = requests.reduce((sum, request) => sum + request[field]!, 0);
  }
  return parseHostUsage(usage);
}

interface TranscriptRequests {
  steps: Map<number, HostUsageRequest | null>;
  complete: boolean;
}

export class AntigravitySessionUsageTracker {
  readonly #file: string;
  readonly #consumed = new Set<number>();
  readonly #requests: HostUsageRequest[] = [];
  readonly #pendingFallbacks: HostUsageRequest[] = [];
  #fallbackSequence = 0;
  #context: HostUsage = {};
  #tokens: HostUsage = {};
  #outputTokensPerSecond?: number;
  #complete = true;
  #lastCollectionSteps = 0;
  #lastCollectionRequests = 0;

  constructor(options: AntigravitySessionUsageTrackerOptions) {
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
    this.recordContextWindow(
      options.initialContextUsedTokens!,
      options.initialContextWindowTokens!,
    );
  }

  currentUsage(): HostUsage | null {
    const tokens = this.#requests.length ? requestUsage(this.#requests) : this.#tokens;
    const usage: HostUsage = { ...tokens, ...this.#context };
    const latest = this.#requests.at(-1);
    if (latest?.cachedInputTokens !== undefined && latest.inputTokens > 0) {
      usage.cacheHitRatePercent = (latest.cachedInputTokens / latest.inputTokens) * 100;
    }
    if (this.#outputTokensPerSecond !== undefined) {
      usage.outputTokensPerSecond = this.#outputTokensPerSecond;
    }
    if (
      this.#complete &&
      this.#requests.length > 0 &&
      this.#requests.every((request) => request.cachedInputTokens !== undefined)
    ) {
      usage.sessionCacheUsage = {
        inputTokens: this.#requests.reduce((sum, request) => sum + request.inputTokens, 0),
        cachedInputTokens: this.#requests.reduce(
          (sum, request) => sum + request.cachedInputTokens!,
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

  recordTurnPromptUsage(input: {
    usage?: AntigravityPromptUsage;
    model?: string;
    firstOutputAtMs?: number;
    completedAtMs?: number;
  }): {
    usage: HostUsage | null;
    fallbackRequest?: HostUsageRequest;
  } {
    const usage = promptUsage(input.usage);
    if (!usage) return { usage: this.currentUsage() };
    if (this.#requests.length === 0) this.#tokens = usage;
    const clock = this.#lastCollectionSteps <= 1 ? timing(input) : {};
    this.#recordOutputSpeed(usage.outputTokens, clock);
    if (
      this.#lastCollectionRequests > 0 ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined
    ) {
      return { usage: this.currentUsage() };
    }
    const fallbackRequest = parseHostUsageRequest({
      requestId: `prompt:${++this.#fallbackSequence}`,
      ...normalizeAntigravityUsageModel(input.model),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
        : {}),
      ...(usage.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: usage.reasoningOutputTokens }
        : {}),
      ...clock,
    });
    this.#requests.push(fallbackRequest);
    this.#pendingFallbacks.push(fallbackRequest);
    return { usage: this.currentUsage(), fallbackRequest };
  }

  async replayHistoricalRequests(signal?: AbortSignal): Promise<{
    requests: HostUsageRequest[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    const transcript = await this.#read(signal);
    const requests = this.#consume(transcript, true);
    return { requests, complete: this.#complete, usage: this.currentUsage() };
  }

  async collectNewTranscriptRequests(
    input: {
      firstOutputAtMs?: number;
      completedAtMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    requests: HostUsageRequest[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    const transcript = await this.#read(input.signal);
    this.#lastCollectionSteps = [...transcript.steps.keys()].filter(
      (step) => !this.#consumed.has(step),
    ).length;
    const requests = this.#consume(transcript, false);
    this.#lastCollectionRequests = requests.length;
    if (requests.length === 1 && this.#lastCollectionSteps === 1 && transcript.complete) {
      Object.assign(requests[0]!, timing(input));
      requests[0] = parseHostUsageRequest(requests[0]);
      this.#recordOutputSpeed(requests[0].outputTokens, requests[0]);
    }
    return { requests, complete: this.#complete, usage: this.currentUsage() };
  }

  #recordOutputSpeed(
    outputTokens: number | undefined,
    clock: Pick<HostUsageRequest, "startedAtMs" | "completedAtMs">,
  ): void {
    if (
      clock.startedAtMs !== undefined &&
      clock.completedAtMs !== undefined &&
      clock.completedAtMs > clock.startedAtMs &&
      outputTokens !== undefined &&
      outputTokens > 0
    ) {
      this.#outputTokensPerSecond =
        outputTokens / ((clock.completedAtMs - clock.startedAtMs) / 1000);
    }
  }

  #consume(transcript: TranscriptRequests, historical: boolean): HostUsageRequest[] {
    this.#complete = transcript.complete;
    const requests: HostUsageRequest[] = [];
    for (const [step, request] of transcript.steps) {
      if (!request || this.#consumed.has(step)) continue;
      this.#consumed.add(step);
      // A delayed single-step transcript must not bill a PromptResponse fallback twice.
      const fallback = this.#pendingFallbacks[0];
      if (
        fallback &&
        fallback.inputTokens === request.inputTokens &&
        fallback.outputTokens === request.outputTokens &&
        fallback.cachedInputTokens === request.cachedInputTokens
      ) {
        this.#pendingFallbacks.shift();
        continue;
      }
      const parsed = parseHostUsageRequest({
        ...request,
        ...(historical ? { historical: true } : {}),
      });
      this.#requests.push(parsed);
      requests.push(parsed);
    }
    return requests;
  }

  async #read(signal?: AbortSignal): Promise<TranscriptRequests> {
    signal?.throwIfAborted();
    const stream = createReadStream(this.#file, { encoding: "utf8", signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const result: TranscriptRequests = { steps: new Map(), complete: true };
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
          request = parseHostUsageRequest({
            requestId: `step:${record.step_index}`,
            ...normalizeAntigravityUsageModel(record.model),
            inputTokens: count(record.input_tokens)
              ? record.input_tokens +
                (count(record.cache_read_tokens) ? record.cache_read_tokens : 0)
              : undefined,
            ...(record.cache_read_tokens !== undefined
              ? { cachedInputTokens: record.cache_read_tokens }
              : {}),
            outputTokens: record.output_tokens,
          });
        } catch {
          // The latest version of a step is authoritative, even when it lacks usage.
        }
        result.steps.set(record.step_index, request);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.complete = false;
    } finally {
      lines.close();
      stream.destroy();
    }
    result.complete &&=
      [...result.steps.values()].every((request) => request !== null) &&
      [...this.#consumed].every((step) => result.steps.has(step));
    return result;
  }
}
