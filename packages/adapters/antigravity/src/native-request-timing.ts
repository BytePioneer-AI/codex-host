import path from "node:path";
import type { DatabaseSync as NativeDatabase } from "node:sqlite";
import type { HostUsageRequest } from "@codexhost/harness-adapter";
import { decodeVarint, readProtoFields, type ProtoField } from "./native-protobuf.js";

export interface AntigravityRequestMetadata {
  reasoningOutputTokens: number;
  contextWindowTokens?: number;
  timing?: {
    requestStartedAtMs: number;
    timeToFirstOutputMs: number;
    startedAtMs: number;
    completedAtMs: number;
  };
}

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const NANOSECONDS_PER_MS = 1_000_000n;
const MAX_MS = BigInt(Number.MAX_SAFE_INTEGER);

function field(fields: ProtoField[], number: number): ProtoField | undefined {
  const matches = fields.filter((candidate) => candidate.number === number);
  return matches.length === 1 ? matches[0] : undefined;
}
function message(fields: ProtoField[], number: number): ProtoField[] | null {
  const value = field(fields, number);
  return value?.wire === 2 && value.value instanceof Uint8Array
    ? readProtoFields(value.value)
    : null;
}
function unsigned(fields: ProtoField[], number: number): bigint | null {
  const values = fields.filter((candidate) => candidate.number === number);
  if (!values.length) return 0n;
  const value = values.length === 1 ? values[0] : undefined;
  return value?.wire === 0 && typeof value.value === "bigint" ? value.value : null;
}
function nanoseconds(fields: ProtoField[] | null): bigint | null {
  if (!fields) return null;
  const seconds = unsigned(fields, 1),
    nanos = unsigned(fields, 2);
  if (seconds === null || nanos === null || nanos >= 1_000_000_000n) return null;
  const result = seconds * 1_000_000_000n + nanos;
  return result / NANOSECONDS_PER_MS <= MAX_MS ? result : null;
}
export function nativeStepCreatedAtMs(blob: unknown): number | undefined {
  const fields = blob instanceof Uint8Array && readProtoFields(blob);
  const timestamp = fields ? nanoseconds(message(fields, 1)) : null;
  return timestamp === null ? undefined : Number(timestamp / NANOSECONDS_PER_MS);
}

export function generatorStepIndices(fields: ProtoField[]): number[] | null {
  const result: number[] = [];
  for (const item of fields.filter((candidate) => candidate.number === 2)) {
    if (item.wire === 0 && typeof item.value === "bigint") {
      if (item.value > 0xffffffffn) return null;
      result.push(Number(item.value));
    } else if (item.wire === 2 && item.value instanceof Uint8Array) {
      for (let offset = 0; offset < item.value.length;) {
        const parsed = decodeVarint(item.value, offset);
        if (!parsed || parsed[0] > 0xffffffffn) return null;
        result.push(Number(parsed[0]));
        offset = parsed[1];
      }
    } else return null;
  }
  return result;
}
function matchesUsage(fields: ProtoField[] | null, request: HostUsageRequest): boolean {
  if (!fields) return false;
  const input = unsigned(fields, 2),
    output = unsigned(fields, 3),
    cached = unsigned(fields, 5),
    thought = unsigned(fields, 9);
  return (
    input !== null &&
    output !== null &&
    cached !== null &&
    thought !== null &&
    output >= thought &&
    (request.reasoningOutputTokens === undefined ||
      thought === BigInt(request.reasoningOutputTokens)) &&
    input + cached + BigInt(request.cacheWriteInputTokens ?? 0) === BigInt(request.inputTokens) &&
    output === BigInt(request.outputTokens) &&
    (request.cachedInputTokens === undefined || cached === BigInt(request.cachedInputTokens))
  );
}
function closeTo(left: bigint, right: bigint): boolean {
  const difference = left - right;
  return difference >= -NANOSECONDS_PER_MS && difference <= NANOSECONDS_PER_MS;
}

function contextWindowTokens(chat: ProtoField[]): number | undefined {
  const start = message(chat, 9);
  const context = start && message(start, 10);
  const maxTokens = context && unsigned(context, 4);
  return maxTokens !== null && maxTokens > 0n && maxTokens <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(maxTokens)
    : undefined;
}

/**
 * agy 1.5.9+: CortexStepMetadata 1/6/7 are created/viewable/finished timestamps;
 * CortexStepGeneratorMetadata 2 names its steps and 1 contains ChatModelMetadata.
 * ChatModelMetadata 4 is ModelUsageStats, 9 is ChatStartMetadata (10 is ContextWindowMetadata,
 * 4 is max_context_tokens), and 11/12 are TTFT/streaming durations.
 * ModelUsageStats 9 is thinking_output_tokens (proto3 uint64).
 * viewable_at is the first visible output, not when hidden thinking began; callers time only
 * the non-thinking Tokens over viewable_at through finished_generating_at.
 */
function requestMetadata(
  metadata: ProtoField[],
  generator: ProtoField[],
  request: HostUsageRequest,
): AntigravityRequestMetadata | null {
  const chat = message(generator, 1);
  const stepUsage = message(metadata, 9);
  const chatUsage = chat && message(chat, 4);
  if (
    !chat ||
    !stepUsage ||
    !chatUsage ||
    !matchesUsage(stepUsage, request) ||
    !matchesUsage(chatUsage, request)
  )
    return null;
  const thought = unsigned(stepUsage, 9);
  if (thought === null || thought !== unsigned(chatUsage, 9)) return null;
  const maxContextTokens = contextWindowTokens(chat);
  const facts: AntigravityRequestMetadata = {
    reasoningOutputTokens: Number(thought),
    ...(maxContextTokens !== undefined ? { contextWindowTokens: maxContextTokens } : {}),
  };
  // Multiple attempts cannot share one trustworthy generation interval.
  if (unsigned(chat, 14) !== 0n || chat.filter((value) => value.number === 17).length > 1)
    return facts;
  const created = nanoseconds(message(metadata, 1));
  const started = nanoseconds(message(metadata, 6));
  const completed = nanoseconds(message(metadata, 7));
  const ttft = nanoseconds(message(chat, 11));
  const streamed = nanoseconds(message(chat, 12));
  if (
    created === null ||
    started === null ||
    completed === null ||
    ttft === null ||
    streamed === null ||
    started < created ||
    completed <= started ||
    streamed <= 0n ||
    !closeTo(started - created, ttft) ||
    !closeTo(completed - started, streamed)
  )
    return facts;
  return {
    ...facts,
    timing: {
      requestStartedAtMs: Number(created / NANOSECONDS_PER_MS),
      timeToFirstOutputMs: Number(ttft / NANOSECONDS_PER_MS),
      startedAtMs: Number(started / NANOSECONDS_PER_MS),
      completedAtMs: Number(completed / NANOSECONDS_PER_MS),
    },
  };
}

/** Null means storage is unavailable; missing entries have no verified request-level facts. */
export async function readAntigravityRequestMetadata(
  nativeSessionId: string,
  home: string,
  requests: ReadonlyMap<number, HostUsageRequest | null>,
  neededSteps: ReadonlySet<number> = new Set(requests.keys()),
): Promise<Map<number, AntigravityRequestMetadata> | null> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(nativeSessionId)) return null;
  let database: NativeDatabase | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(
      path.join(home, ".gemini/antigravity-cli/conversations", `${nativeSessionId}.db`),
      { readOnly: true },
    );
    database.exec("BEGIN");
    const stepQuery = database.prepare(
      `SELECT CASE WHEN length(metadata) <= ${MAX_METADATA_BYTES} THEN metadata END AS metadata FROM steps WHERE idx = ?`,
    );
    const generatorQuery = database.prepare(
      `SELECT CASE WHEN length(data) <= ${MAX_METADATA_BYTES} THEN data END AS data FROM gen_metadata WHERE idx = ?`,
    );
    const result = new Map<number, AntigravityRequestMetadata>();
    for (const index of neededSteps) {
      const request = requests.get(index);
      if (!request) continue;
      const row = stepQuery.get(index);
      if (!(row?.metadata instanceof Uint8Array)) continue;
      const metadata = readProtoFields(row.metadata);
      // SourceTrajectoryStepInfo explicitly names both this step and its generator row.
      const source = metadata && message(metadata, 20);
      const generatorIndex = source && unsigned(source, 3);
      const cascade = source && field(source, 4);
      if (
        !metadata ||
        !source ||
        cascade?.wire !== 2 ||
        !(cascade.value instanceof Uint8Array) ||
        Buffer.from(cascade.value).toString("utf8") !== nativeSessionId ||
        unsigned(source, 2) !== BigInt(index) ||
        generatorIndex === null ||
        generatorIndex > BigInt(Number.MAX_SAFE_INTEGER)
      )
        continue;
      const usage = message(metadata, 9);
      if (!usage || !matchesUsage(usage, request)) continue;
      // Request-level usage can be committed before optional generator timing.
      result.set(index, { reasoningOutputTokens: Number(unsigned(usage, 9)) });
      const generated = generatorQuery.get(Number(generatorIndex));
      if (!(generated?.data instanceof Uint8Array)) continue;
      const fields = readProtoFields(generated.data);
      const indices = fields && generatorStepIndices(fields);
      if (!fields || !indices) continue;
      const plannerSteps = [...new Set(indices.filter((step) => requests.get(step)))];
      if (plannerSteps.length !== 1 || plannerSteps[0] !== index) continue;
      const facts = requestMetadata(metadata, fields, request);
      if (facts) result.set(index, facts);
      else result.delete(index);
    }
    return result;
  } catch {
    // Optional native timing never makes token accounting or conversation loading fail.
    return null;
  } finally {
    database?.close();
  }
}
