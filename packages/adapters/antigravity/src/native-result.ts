import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { nativeConversationDbPath } from "./fork.js";
import type { AntigravityResultEvent } from "./stream-events.js";

interface NativeTurnBoundary {
  stepIndex: number;
  generatorIndex: number;
  executorIndex: number;
  userCount: number;
}

/** These are agy's persisted USER_INPUT, PLANNER_RESPONSE, ERROR_MESSAGE and DONE values. */
const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const DONE = 3;
const MAX_CURRENT_STEPS = 4_096;

/** agy's protobuf metadata has a top-level error in Generator field 5 / Executor field 12. */
function metadataHasError(data: Uint8Array, errorField: number): boolean | null {
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = data[offset++];
      if (byte === undefined) throw new Error("Truncated metadata");
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error("Invalid metadata value");
        return value;
      }
    }
    throw new Error("Invalid metadata varint");
  };
  try {
    while (offset < data.byteLength) {
      const tag = varint();
      if (tag < 8) return null;
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (wire === 0) varint();
      else if (wire === 1) offset += 8;
      else if (wire === 5) offset += 4;
      else if (wire === 2) {
        const length = varint();
        offset += length;
        if (offset > data.byteLength) return null;
        if (field === errorField && length > 0) return true;
      } else return null;
      if (offset > data.byteLength) return null;
    }
    return false;
  } catch {
    return null;
  }
}

async function readConversation<T>(
  conversationId: string,
  read: (db: DatabaseSync) => T,
  home?: string,
): Promise<T | null> {
  if (!z.uuid().safeParse(conversationId).success) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(nativeConversationDbPath(conversationId, home), { readOnly: true });
    try {
      const identity = db.prepare("SELECT cascade_id FROM trajectory_meta").get();
      if (identity?.cascade_id !== conversationId) return null;
      db.exec("BEGIN");
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    // An unavailable or changed native format cannot establish successful recovery.
    return null;
  }
}

export function captureNativeTurnBoundary(
  conversationId: string,
  home?: string,
): Promise<NativeTurnBoundary | null> {
  return readConversation(
    conversationId,
    (db) => ({
      stepIndex: Number(db.prepare("SELECT coalesce(max(idx), -1) AS n FROM steps").get()?.n),
      generatorIndex: Number(
        db.prepare("SELECT coalesce(max(idx), -1) AS n FROM gen_metadata").get()?.n,
      ),
      executorIndex: Number(
        db.prepare("SELECT coalesce(max(idx), -1) AS n FROM executor_metadata").get()?.n,
      ),
      userCount: Number(
        db.prepare("SELECT count(*) AS n FROM steps WHERE step_type = ?").get(USER_INPUT)?.n,
      ),
    }),
    home,
  );
}

/**
 * agy can return ERROR with a previous Turn's error_message after a new Turn
 * finishes. Verify the new native trajectory before correcting that summary;
 * text already streamed to Desktop alone does not prove successful completion.
 */
export async function isHistoricalNativeError(
  result: AntigravityResultEvent["result"],
  boundary: NativeTurnBoundary | null,
  streamedResponse: string,
  home?: string,
): Promise<boolean> {
  const error = result.error?.trim();
  if (result.status !== "ERROR" || !error || !boundary || !streamedResponse.trim()) return false;
  if (result.num_turns !== boundary.userCount + 1) return false;
  return (
    (await readConversation(
      result.conversation_id,
      (db) => {
        const steps = db
          .prepare(
            "SELECT idx, step_type, status, length(error_details) AS error_bytes FROM steps WHERE idx > ? ORDER BY idx LIMIT ?",
          )
          .all(boundary.stepIndex, MAX_CURRENT_STEPS + 1);
        if (steps.length > MAX_CURRENT_STEPS) return false;
        const inputs = steps.filter((step) => step.step_type === USER_INPUT);
        if (inputs.length !== 1) return false;
        const input = inputs[0];
        if (!input || typeof input.idx !== "number") return false;
        const current = steps.filter((step) => Number(step.idx) >= Number(input.idx));
        if (
          current.some(
            (step) =>
              step.status !== DONE ||
              step.step_type === ERROR_MESSAGE ||
              (step.error_bytes != null && step.error_bytes !== 0),
          )
        ) {
          return false;
        }
        const last = current.at(-1);
        if (last?.step_type !== PLANNER_RESPONSE) return false;
        const payload = db
          .prepare("SELECT step_payload FROM steps WHERE idx = ?")
          .get(last.idx ?? -1)?.step_payload;
        if (!(payload instanceof Uint8Array)) return false;
        // Match the fresh streamed response to the final native step, not result.response:
        // the CLI summary can contain historical text along with its historical error.
        const prefix = Buffer.from(streamedResponse.trim().slice(0, 128));
        if (!Buffer.from(payload).includes(prefix)) return false;
        const needle = Buffer.from(error);
        const oldError = db
          .prepare(
            "SELECT idx FROM steps WHERE idx < ? AND step_type = ? AND instr(step_payload, ?) > 0 LIMIT 1",
          )
          .get(input.idx, ERROR_MESSAGE, needle);
        if (!oldError) return false;
        for (const [table, index, errorField] of [
          ["gen_metadata", boundary.generatorIndex, 5],
          ["executor_metadata", boundary.executorIndex, 12],
        ] as const) {
          let count = 0;
          for (const row of db.prepare(`SELECT data FROM ${table} WHERE idx > ?`).iterate(index)) {
            if (++count > MAX_CURRENT_STEPS || !(row.data instanceof Uint8Array)) return false;
            if (metadataHasError(row.data, errorField) !== false) return false;
          }
        }
        return true;
      },
      home,
    )) === true
  );
}
