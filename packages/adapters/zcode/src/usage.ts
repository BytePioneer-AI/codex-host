import {
  parseHostUsageRequest,
  type HostEvent,
  type HostUsageRequest,
} from "@codexhost/harness-adapter";
import { record, text, type NativeEvent, type NativeMessage } from "./protocol.js";

type UsageRecord = { kind: "request"; request: HostUsageRequest } | { kind: "none" | "missing" };

/**
 * ZCode 3.14.4's message tokens are AI SDK total input/output: cache and reasoning are
 * breakdowns, not additions. Verified against session/resume and native model_usage rows.
 * Require the total identity too: older/unknown conventions must not silently be priced.
 */
function requestTokens(id: string, model: string | undefined, value: unknown): HostUsageRequest {
  const tokens = record(value),
    cache = record(tokens.cache);
  const request = parseHostUsageRequest({
    requestId: id,
    ...(model ? { model } : {}),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    ...(cache.read !== undefined ? { cachedInputTokens: cache.read } : {}),
    ...(cache.write !== undefined ? { cacheWriteInputTokens: cache.write } : {}),
    ...(tokens.reasoning !== undefined ? { reasoningOutputTokens: tokens.reasoning } : {}),
  });
  if (
    !Number.isSafeInteger(tokens.total) ||
    tokens.total !== request.inputTokens + request.outputTokens
  )
    throw new Error("ZCode request token convention is unknown");
  return request;
}

export function zcodeUsageRecord(message: NativeMessage): UsageRecord {
  const info = message.info;
  if (info.role !== "assistant" || info.synthetic === true || info.semantics?.origin === "system")
    return { kind: "none" };
  if (info.time.completed === undefined) return { kind: "missing" };
  const tokens = record(info.tokens),
    cache = record(tokens.cache);
  // A cancelled/failed native message has a zero placeholder, not provider usage. Follow the
  // shared failed-request policy: omit it rather than fabricate a priced zero-token request.
  if (
    info.error &&
    tokens.total === undefined &&
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    cache.read === 0 &&
    cache.write === 0
  )
    return { kind: "none" };
  try {
    return {
      kind: "request",
      request: requestTokens(info.messageId, info.model?.modelId, info.tokens),
    };
  } catch {
    return { kind: "missing" };
  }
}

interface PendingRequest {
  id: string;
  turnId: string | undefined;
  model: string;
  messageId?: string;
  startedAtMs?: number;
  ambiguous: boolean;
}

/** Session-owned protocol observation; no database reader or second persisted ledger. */
export class ZcodeUsage {
  readonly #seen = new Map<string, HostUsageRequest>();
  #pending: PendingRequest | undefined;
  readonly #timings = new Map<string, { startedAtMs: number; completedAtMs: number }>();
  #complete = true;

  constructor(
    readonly sessionId: string,
    readonly emit: (event: HostEvent) => void,
  ) {}

  invalidate() {
    if (!this.#complete) return;
    this.#complete = false;
    this.emit({ type: "usage.history", complete: false });
  }

  replay(messages: readonly NativeMessage[], historical: boolean) {
    for (const message of messages) {
      if (message.info.sessionId !== this.sessionId) continue;
      const result = zcodeUsageRecord(message);
      if (result.kind === "missing") this.invalidate();
      else if (result.kind === "request") {
        this.#publish({
          ...result.request,
          ...(historical ? { historical: true } : this.#timings.get(result.request.requestId)),
        });
      }
    }
    // Only initialization declares completeness; later good snapshots cannot heal a gap.
    if (historical) this.emit({ type: "usage.history", complete: this.#complete });
    this.#pending = undefined;
    this.#timings.clear();
  }

  #publish(request: HostUsageRequest) {
    // ZCode's protocol filters reasoning_start; it cannot prove when hidden reasoning began.
    // Don't divide reasoning-inclusive output by a potentially text-only interval.
    if ((request.reasoningOutputTokens ?? 0) > 0) {
      request = { ...request };
      delete request.startedAtMs;
      delete request.completedAtMs;
    }
    const previous = this.#seen.get(request.requestId);
    if (previous) {
      // Host uses first-wins deduplication. A changed final record is a gap, not a new request.
      if (
        previous.model !== request.model ||
        previous.inputTokens !== request.inputTokens ||
        previous.outputTokens !== request.outputTokens ||
        previous.cachedInputTokens !== request.cachedInputTokens ||
        previous.cacheWriteInputTokens !== request.cacheWriteInputTokens ||
        (previous.reasoningOutputTokens ?? 0) !== (request.reasoningOutputTokens ?? 0)
      )
        this.invalidate();
      return;
    }
    this.#seen.set(request.requestId, request);
    this.emit({ type: "usage.request", request });
  }

  observe(event: NativeEvent) {
    if (event.sessionId !== this.sessionId) return;
    const p = event.payload ?? {};
    if (event.type === "turn.started") {
      this.#pending = undefined;
      this.#timings.clear();
      return;
    }
    if (event.type === "model.streaming") {
      const pending = this.#pending;
      if (!pending || pending.turnId !== event.turnId || p.source === "subagent") return;
      const id = text(p.assistantMessageId);
      if (!id) return;
      // The main runtime serializes requests; require exactly one message in this request.
      // If a future protocol interleaves them, fall back to the settled native snapshot.
      if (pending.messageId && pending.messageId !== id) pending.ambiguous = true;
      pending.messageId = id;
      if (
        pending.startedAtMs === undefined &&
        (((p.kind === "text_delta" || p.kind === "reasoning_delta") && text(p.delta)) ||
          p.kind === "tool_input_start" ||
          (p.kind === "tool_input_delta" && text(p.delta)) ||
          p.kind === "tool_call")
      )
        pending.startedAtMs = event.timestamp;
      return;
    }
    if (event.type !== "session.updated" || p.querySource !== "main_turn") return;
    if (p.type === "model_request_started") {
      const id = text(p.requestId),
        model = text(p.modelId);
      if (!id || !model) return;
      this.#pending = {
        id,
        model,
        turnId: event.turnId,
        ambiguous: this.#pending !== undefined,
      };
      return;
    }
    if (p.type !== "model_request_completed") return;
    const pending = this.#pending;
    if (!pending || pending.id !== p.requestId || pending.turnId !== event.turnId) return;
    this.#pending = undefined;
    if (pending.ambiguous || !pending.messageId || pending.model !== p.modelId) return;
    const start = pending.startedAtMs;
    if (
      start !== undefined &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(event.timestamp) &&
      event.timestamp >= start
    )
      this.#timings.set(pending.messageId, {
        startedAtMs: start,
        completedAtMs: event.timestamp,
      });
    const usage = record(p.usage);
    // Some Providers omit cache write in the stream; don't publish an unknown record before
    // the native final message supplies its normalized cache fields (Host is first-wins).
    if (usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined) return;
    try {
      const request = requestTokens(pending.messageId, pending.model, {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
        reasoning: usage.reasoningTokens,
        cache: { read: usage.cacheReadTokens, write: usage.cacheWriteTokens },
      });
      this.#publish({ ...request, ...this.#timings.get(pending.messageId) });
    } catch {
      this.invalidate();
    }
  }
}
