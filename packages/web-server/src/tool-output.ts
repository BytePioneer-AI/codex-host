/** Per-browser previews over the shared, already capped rendering journal. */
import { createHash } from "node:crypto";
import type { WebToolOutputPreview, WebToolOutputReference } from "@codexhost/shared-contracts";
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
const version = (text: string) => createHash("sha256").update(text).digest("hex");
const resultData = (event: WireEvent) => event.data as ResultData;

/** Spend one response's soft budget newest-first, retaining record order and full active Turns. */
export function toolOutputRecords(
  log: SessionLog,
  records: readonly { type: "event"; event: WireEvent }[],
): Array<{ type: "event"; event: WireEvent }> {
  const ended = new Set(
    log.events
      .filter((event) => event.type === "turn/end")
      .map((event) => (event.data as { turn: number }).turn),
  );
  let sent = 0;
  return records
    .toReversed()
    .map((record): { type: "event"; event: WireEvent } => {
      const event = record.event;
      if (event.type !== "tool/result") return record;
      const data = resultData(event);
      if (!ended.has(data.turn)) return record;
      const previews: WebToolOutputPreview[] = [];
      const content = data.message.content.map((block, part) => {
        if (block.type !== "text" || block.text === undefined) return block;
        const text = block.text;
        if (
          text.length <= TOOL_OUTPUT_LIMIT &&
          (sent + text.length <= TOOL_OUTPUT_WINDOW_BUDGET || text.length <= TOOL_OUTPUT_PREVIEW)
        ) {
          sent += text.length;
          return block;
        }
        let end = TOOL_OUTPUT_PREVIEW;
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
        const preview = text.slice(0, end);
        sent += preview.length;
        previews.push({
          reference: {
            sessionId: log.header.id,
            epoch: log.epoch,
            turn: data.turn,
            seq: event.seq,
            callId: String(data.message.source.callId),
            part,
            version: version(text),
          },
          length: text.length,
          bytes: Buffer.byteLength(text, "utf8"),
        });
        return { ...block, text: preview };
      });
      if (!previews.length) return record;
      const meta = typeof data.meta === "object" && data.meta !== null ? data.meta : {};
      return {
        type: "event",
        event: {
          ...event,
          data: {
            ...data,
            message: { ...data.message, content },
            meta: { ...meta, codexhostOutput: previews },
          },
        },
      };
    })
    .reverse();
}

/** Apply only at a trusted relay connection's sending edge, never to the shared journal. */
export function toolOutputSink(log: SessionLog, sink: StreamSink): StreamSink {
  if (!sink.relay) return sink;
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
  const text = data?.message.content[ref.part]?.text;
  if (
    ref.sessionId !== log.header.id ||
    ref.epoch !== log.epoch ||
    data?.turn !== ref.turn ||
    String(data?.message.source.callId) !== ref.callId ||
    typeof text !== "string" ||
    version(text) !== ref.version
  )
    throw new RpcError(
      "session/tool-output-stale",
      "Tool output changed. Refresh the conversation.",
    );
  return { text };
}
