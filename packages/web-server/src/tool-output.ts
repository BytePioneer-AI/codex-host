/** Per-browser previews and bounded memory compaction for settled tool output. */
import { createHash } from "node:crypto";
import {
  webToolOutputPreviews,
  type WebToolOutputPreview,
  type WebToolOutputReference,
} from "@codexhost/shared-contracts";
import type { SessionLog, WireEvent } from "@codexhost/session-runtime/session-log";
import { RpcError, type StreamSink } from "./transport.ts";

export const TOOL_OUTPUT_LIMIT = 64 * 1024;
export const TOOL_OUTPUT_PREVIEW = 8 * 1024;
export const TOOL_OUTPUT_WINDOW_BUDGET = 128 * 1024;

interface ResultData {
  turn: number;
  message: { source: { callId: string }; content: Array<{ type: string; text?: string }> };
  meta?: unknown;
}

export function toolOutputVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function previewToolText(text: string): string {
  if (text.length <= TOOL_OUTPUT_PREVIEW) return text;
  let end = TOOL_OUTPUT_PREVIEW;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

const resultData = (event: WireEvent) => event.data as ResultData;

function staleToolOutput(): RpcError {
  return new RpcError(
    "session/tool-output-stale",
    "Tool output changed. Refresh the conversation.",
  );
}

function sameReference(a: WebToolOutputReference, b: WebToolOutputReference): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.epoch === b.epoch &&
    a.turn === b.turn &&
    a.seq === b.seq &&
    a.callId === b.callId &&
    a.part === b.part &&
    a.version === b.version
  );
}

function endedTurns(log: SessionLog): Set<number> {
  return new Set(
    log.events
      .filter((event) => event.type === "turn/end")
      .map((event) => (event.data as { turn: number }).turn),
  );
}

function applyBudgetToEvent(
  log: SessionLog,
  event: WireEvent,
  ended: ReadonlySet<number>,
  state: { sent: number },
): WireEvent | undefined {
  if (event.type !== "tool/result") return undefined;
  const data = resultData(event);
  if (!ended.has(data.turn)) return undefined;
  const existing = webToolOutputPreviews(data.meta);
  const existingByPart = new Map(existing.map((preview) => [preview.reference.part, preview]));
  const previews: WebToolOutputPreview[] = [];
  let changed = false;
  const content = data.message.content.map((block, part) => {
    if (block.type !== "text" || block.text === undefined) return block;
    const text = block.text;
    const preserved = existingByPart.get(part);
    if (preserved) {
      state.sent += text.length;
      previews.push(preserved);
      return block;
    }
    if (
      text.length <= TOOL_OUTPUT_LIMIT &&
      (state.sent + text.length <= TOOL_OUTPUT_WINDOW_BUDGET || text.length <= TOOL_OUTPUT_PREVIEW)
    ) {
      state.sent += text.length;
      return block;
    }
    const preview = previewToolText(text);
    state.sent += preview.length;
    changed = true;
    previews.push({
      reference: {
        sessionId: log.header.id,
        epoch: log.epoch,
        turn: data.turn,
        seq: event.seq,
        callId: String(data.message.source.callId),
        part,
        version: toolOutputVersion(text),
      },
      length: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
    });
    return { ...block, text: preview };
  });
  if (!changed) return undefined;
  const meta = typeof data.meta === "object" && data.meta !== null ? data.meta : {};
  return {
    ...event,
    data: {
      ...data,
      message: { ...data.message, content },
      meta: { ...meta, codexhostOutput: previews },
    },
  };
}

/** Spend one response's soft budget newest-first, retaining record order and full active Turns. */
export function toolOutputRecords(
  log: SessionLog,
  records: readonly { type: "event"; event: WireEvent }[],
): Array<{ type: "event"; event: WireEvent }> {
  const ended = endedTurns(log);
  const state = { sent: 0 };
  return records
    .toReversed()
    .map((record): { type: "event"; event: WireEvent } => {
      const compacted = applyBudgetToEvent(log, record.event, ended, state);
      return compacted ? { type: "event", event: compacted } : record;
    })
    .reverse();
}

/**
 * Release over-limit and over-budget settled tool output text from a disposable journal,
 * replacing affected array slots with immutable preview events carrying SHA-256 metadata.
 */
export function compactLogToolOutputs(log: SessionLog): void {
  const ended = endedTurns(log);
  const state = { sent: 0 };
  for (let index = log.events.length - 1; index >= 0; index -= 1) {
    const event = log.events[index];
    if (!event) continue;
    const compacted = applyBudgetToEvent(log, event, ended, state);
    if (compacted) log.events[index] = compacted;
  }
}

/** Preview historical snapshots on every browser connection; pass live events through untouched. */
export function toolOutputSink(log: SessionLog, sink: StreamSink): StreamSink {
  return {
    ...sink,
    get closed() {
      return sink.closed;
    },
    push(value) {
      const frame = value as {
        type: string;
        records?: Array<{ type: "event"; event: WireEvent }>;
      };
      if (frame.type === "snapshot" && frame.records) {
        sink.push({ ...frame, records: toolOutputRecords(log, frame.records) });
      } else sink.push(value);
    },
  };
}

/** Authorization is checked by the caller before resolving any client-supplied coordinates. */
export function readToolOutput(log: SessionLog, ref: WebToolOutputReference): { text: string } {
  const event = log.events.find((event) => event.seq === ref.seq && event.type === "tool/result");
  const data = event && resultData(event);
  const block = data?.message.content[ref.part];
  const text = block?.type === "text" ? block.text : undefined;
  const compacted = data
    ? webToolOutputPreviews(data.meta).some((preview) => preview.reference.part === ref.part)
    : false;
  if (
    compacted ||
    ref.sessionId !== log.header.id ||
    ref.epoch !== log.epoch ||
    data?.turn !== ref.turn ||
    String(data?.message.source.callId) !== ref.callId ||
    typeof text !== "string" ||
    toolOutputVersion(text) !== ref.version
  )
    throw staleToolOutput();
  return { text };
}

/**
 * Resolve full tool output from memory or, when settled text was compacted out of the journal,
 * reload via the caller-supplied Host reader and verify the SHA-256 version fingerprint.
 */
export async function resolveToolOutput(
  log: SessionLog,
  ref: WebToolOutputReference,
  loadFull?: (ref: WebToolOutputReference) => Promise<string | undefined>,
): Promise<{ text: string }> {
  const event = log.events.find((entry) => entry.seq === ref.seq && entry.type === "tool/result");
  const data = event && resultData(event);
  const block = data?.message.content[ref.part];
  const text = block?.type === "text" ? block.text : undefined;
  if (
    ref.sessionId !== log.header.id ||
    ref.epoch !== log.epoch ||
    data?.turn !== ref.turn ||
    String(data?.message.source.callId) !== ref.callId ||
    typeof text !== "string"
  )
    throw staleToolOutput();
  const existing = webToolOutputPreviews(data.meta).find(
    (preview) => preview.reference.part === ref.part,
  );
  if (existing) {
    if (!sameReference(existing.reference, ref) || !loadFull) throw staleToolOutput();
    const full = await loadFull(ref);
    if (
      ref.sessionId !== log.header.id ||
      ref.epoch !== log.epoch ||
      typeof full !== "string" ||
      toolOutputVersion(full) !== ref.version
    )
      throw staleToolOutput();
    return { text: full };
  }
  if (toolOutputVersion(text) !== ref.version) throw staleToolOutput();
  return { text };
}
