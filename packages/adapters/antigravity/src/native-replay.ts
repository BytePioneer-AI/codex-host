import type { DatabaseSync } from "node:sqlite";
import type { AntigravityAcpEvent } from "./acp-types.js";
import { readProtoFields, type ProtoField } from "./native-protobuf.js";
import { nativeConversationDbPath } from "./native-turn-boundaries.js";

export type NativeReplayEvent =
  AntigravityAcpEvent | { type: "history.autonomous"; stepIndex: number };

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const SYSTEM_MESSAGE = 101;
const GENERIC_TOOL = 132;
const DONE = 3;
const ERROR = 7;
const IN_FLIGHT = new Set([1, 2, 8, 9, 11]);

function message(payload: unknown): ProtoField[] {
  const fields = payload instanceof Uint8Array ? readProtoFields(payload) : null;
  if (!fields) throw new Error("Invalid Antigravity history protobuf");
  return fields;
}

function messageField(fields: readonly ProtoField[], number: number): Uint8Array | undefined {
  const field = fields.find((entry) => entry.number === number && entry.wire === 2);
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function nested(fields: readonly ProtoField[], number: number): ProtoField[] {
  const payload = messageField(fields, number);
  return payload ? message(payload) : [];
}

function textField(fields: readonly ProtoField[], number: number): string {
  const bytes = messageField(fields, number);
  return bytes ? Buffer.from(bytes).toString("utf8") : "";
}

function argsValue(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Read committed history in step order and feed the same event shapes as the history projector. */
export async function readNativeHistory(
  sessionId: string,
  home: string,
): Promise<ReturnType<typeof decodeNativeHistory>> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(sessionId)) throw new Error("Invalid native Session ID");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(nativeConversationDbPath(sessionId, home), { readOnly: true });
  try {
    db.exec("BEGIN");
    return decodeNativeHistory(db);
  } finally {
    db.close();
  }
}

export function decodeNativeHistory(db: DatabaseSync) {
  const events: NativeReplayEvent[] = [];
  const pendingCalls = new Set<string>();
  let turnCount = 0;
  let run = "";
  let candidate: { stepIndex: number; run: string } | undefined;
  let wake: { eventIndex: number; settled: boolean } | undefined;
  let finalPlanner = false;
  const endWake = () => {
    if (wake && !wake.settled) events.length = wake.eventIndex;
    wake = undefined;
    candidate = undefined;
  };
  const append = (type: "agent.text" | "agent.thought", text: string) => {
    if (text) events.push({ type, text: events.at(-1)?.type === type ? `\n\n${text}` : text });
  };
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 1)
    throw new Error("Unsupported Antigravity history database version");
  for (const row of db
    .prepare(
      `SELECT idx, step_type, status, step_payload FROM steps
       WHERE step_type IN (${USER_INPUT}, ${PLANNER_RESPONSE}, ${ERROR_MESSAGE}, ${SYSTEM_MESSAGE}, ${GENERIC_TOOL})
       ORDER BY idx`,
    )
    .iterate()) {
    const idx = Number(row.idx);
    const nativeTurnIndex = row.step_type === USER_INPUT ? turnCount++ : undefined;
    if (nativeTurnIndex !== undefined) {
      endWake();
      finalPlanner = false;
    }
    if (IN_FLIGHT.has(Number(row.status))) {
      if (wake && row.step_type === PLANNER_RESPONSE) wake.settled = false;
      continue;
    }
    const step = message(row.step_payload);
    // CascadeStep.metadata.run_id is shared by input, system messages and planner
    // steps in the same execution. A system message inside that run is not a boundary.
    const stepRun = textField(nested(step, 5), 12);
    if (row.step_type === SYSTEM_MESSAGE) {
      if (row.status === DONE && (stepRun ? stepRun !== run : finalPlanner)) {
        if (candidate?.run !== stepRun) {
          // A new run's in-flight planner must not unsettle the previous wake.
          endWake();
          candidate = { stepIndex: idx, run: stepRun };
        }
      }
      continue;
    }
    if (row.step_type === USER_INPUT) run = stepRun;
    const number =
      row.step_type === USER_INPUT
        ? 19
        : row.step_type === PLANNER_RESPONSE
          ? 20
          : row.step_type === ERROR_MESSAGE
            ? 24
            : 140;
    const body = message(messageField(step, number));
    switch (row.step_type) {
      case USER_INPUT: {
        const items = body.flatMap((field) =>
          field.number === 3 && field.wire === 2 ? [textField(message(field.value), 1)] : [],
        );
        const text = items.join("") || textField(body, 2) || textField(body, 1);
        pendingCalls.clear();
        if (text && nativeTurnIndex !== undefined)
          events.push({ type: "user.text", text, nativeTurnIndex });
        break;
      }
      case PLANNER_RESPONSE: {
        const thought = textField(body, 3);
        const text = textField(body, 1);
        const calls = body.filter((field) => field.number === 7 && field.wire === 2);
        if (candidate && candidate.run === stepRun) {
          const { stepIndex } = candidate;
          endWake();
          wake = { eventIndex: events.length, settled: false };
          events.push({ type: "history.autonomous", stepIndex });
          pendingCalls.clear();
        }
        if (stepRun) run = stepRun;
        finalPlanner = row.status === DONE && !!text.trim() && calls.length === 0;
        if (wake) wake.settled = finalPlanner;
        append("agent.thought", thought);
        append("agent.text", text);
        for (const field of body) {
          if (field.number !== 7 || field.wire !== 2) continue;
          const call = message(field.value);
          const toolCallId = textField(call, 1);
          const name = textField(call, 2);
          if (!toolCallId || !name) continue;
          pendingCalls.add(toolCallId);
          events.push({
            type: "tool.call",
            toolCallId,
            name,
            args: argsValue(textField(call, 3)),
          });
        }
        break;
      }
      case ERROR_MESSAGE: {
        // A wake without a final planner reply is not part of the previous Turn.
        if (candidate?.run === stepRun) break;
        const warning = textField(nested(body, 3), 2);
        if (warning) append("agent.text", `⚠ ${warning}`);
        break;
      }
      case GENERIC_TOOL: {
        const toolCallId = textField(nested(nested(step, 5), 4), 1);
        if (!pendingCalls.delete(toolCallId)) break;
        const error = nested(step, 31);
        const output =
          textField(nested(body, 2), 1) ||
          textField(error, 3) ||
          textField(error, 2) ||
          textField(error, 1);
        const status =
          row.status === DONE ? "completed" : row.status === ERROR ? "failed" : "cancelled";
        events.push({
          type: "tool.update",
          toolCallId,
          status,
          ...(output ? { rawOutput: output } : {}),
        });
        break;
      }
    }
  }
  endWake();
  const wakeWatermark =
    events.findLast((event) => event.type === "history.autonomous")?.stepIndex ?? -1;
  return { events, turnCount, wakeWatermark };
}
