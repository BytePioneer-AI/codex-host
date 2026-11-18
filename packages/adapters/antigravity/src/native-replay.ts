import type { AntigravityAcpEvent } from "./acp-types.js";
import { nativeConversationDbPath } from "./fork.js";
import { readProtoFields, type ProtoField } from "./native-protobuf.js";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
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
): Promise<{ events: AntigravityAcpEvent[]; turnCount: number }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(sessionId)) throw new Error("Invalid native Session ID");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(nativeConversationDbPath(sessionId, home), { readOnly: true });
  const events: AntigravityAcpEvent[] = [];
  const pendingCalls = new Set<string>();
  let turnCount = 0;
  const append = (type: "agent.text" | "agent.thought", text: string) => {
    if (text) events.push({ type, text: events.at(-1)?.type === type ? `\n\n${text}` : text });
  };
  try {
    db.exec("BEGIN");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1)
      throw new Error("Unsupported Antigravity history database version");
    for (const row of db
      .prepare(
        `SELECT step_type, status, step_payload FROM steps
       WHERE step_type IN (${USER_INPUT}, ${PLANNER_RESPONSE}, ${ERROR_MESSAGE}, ${GENERIC_TOOL})
       ORDER BY idx`,
      )
      .iterate()) {
      if (row.step_type === USER_INPUT) turnCount++;
      if (IN_FLIGHT.has(Number(row.status))) continue;
      const step = message(row.step_payload);
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
          if (text) events.push({ type: "user.text", text });
          break;
        }
        case PLANNER_RESPONSE: {
          append("agent.thought", textField(body, 3));
          append("agent.text", textField(body, 1));
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
    return { events, turnCount };
  } finally {
    db.close();
  }
}
