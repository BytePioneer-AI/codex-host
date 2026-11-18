import { access } from "node:fs/promises";
import type { DatabaseSync as SqliteDatabaseSync } from "node:sqlite";
import type { AntigravityAcpEvent } from "./acp-types.js";
import { AntigravityTransportError } from "./acp-types.js";
import { nativeConversationDbPath, nativeConversationSummariesDbPath } from "./fork.js";
import { readProtoFields } from "./native-protobuf.js";

interface ReplaySize {
  users: number;
  text: number;
  thought: number;
  tools: number;
  sessionInfo?: boolean;
}

function protoBytes(blob: Uint8Array | undefined, fieldNumber: number): Uint8Array | undefined {
  const value = blob
    ? readProtoFields(blob)?.find((field) => field.number === fieldNumber)?.value
    : undefined;
  return value instanceof Uint8Array ? value : undefined;
}

function firstNonEmptyProtoBytes(
  blob: Uint8Array | undefined,
  ...fieldNumbers: number[]
): Uint8Array | undefined {
  for (const fieldNumber of fieldNumbers) {
    const candidate = protoBytes(blob, fieldNumber);
    if (candidate?.length) return candidate;
  }
  return undefined;
}

function invalidReplayError(): AntigravityTransportError {
  return new AntigravityTransportError("protocolError", "Cannot verify Antigravity history replay");
}

async function hasNativeSessionTitle(
  sessionId: string,
  home: string,
  DatabaseSync: typeof SqliteDatabaseSync,
): Promise<boolean> {
  const summaryPath = nativeConversationSummariesDbPath(home);
  try {
    await access(summaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }
  const summaries = new DatabaseSync(summaryPath, { readOnly: true });
  try {
    const row = summaries
      .prepare("SELECT title, raw_summary FROM conversation_summaries WHERE conversation_id = ?")
      .get(sessionId);
    if (!row || typeof row.title !== "string" || row.title.length === 0) return false;
    if (row.raw_summary instanceof Uint8Array) {
      return Boolean(protoBytes(protoBytes(row.raw_summary, 15), 1)?.length);
    }
    return true;
  } finally {
    summaries.close();
  }
}

/** Native user boundaries and replayed payload sizes, including the final reply. */
export async function readNativeReplaySize(sessionId: string, home: string): Promise<ReplaySize> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(sessionId))
    throw new AntigravityTransportError("protocolError", "Invalid native Session ID");
  const { DatabaseSync } = await import("node:sqlite");
  const sessionInfo = await hasNativeSessionTitle(sessionId, home, DatabaseSync);
  const db = new DatabaseSync(nativeConversationDbPath(sessionId, home), { readOnly: true });
  const size: ReplaySize = { users: 0, text: 0, thought: 0, tools: 0, sessionInfo };
  const toolCallIds = new Set<string>();
  let hadTextInTurn = false;
  try {
    for (const row of db
      .prepare(
        "SELECT step_type, step_payload FROM steps WHERE step_type IN (14, 15, 17, 132) ORDER BY idx",
      )
      .iterate()) {
      if (row.step_type === 14) {
        size.users++;
        hadTextInTurn = false;
        continue;
      }
      if (row.step_type === 17) {
        const errorStep =
          row.step_payload instanceof Uint8Array ? protoBytes(row.step_payload, 24) : undefined;
        if (!errorStep || !readProtoFields(errorStep)) throw invalidReplayError();
        const detail = protoBytes(errorStep, 3);
        if (detail && !readProtoFields(detail)) throw invalidReplayError();
        const message = firstNonEmptyProtoBytes(detail, 9, 1, 2);
        if (message?.length) size.text += Buffer.from(message).toString("utf8").length + 4;
        continue;
      }
      if (row.step_type === 132) {
        const outer =
          row.step_payload instanceof Uint8Array ? readProtoFields(row.step_payload) : null;
        if (!outer) throw invalidReplayError();
        if (outer.find((field) => field.number === 4)?.value === 4n) {
          const metadata = outer.find((field) => field.number === 5)?.value;
          const callId = protoBytes(
            protoBytes(metadata instanceof Uint8Array ? metadata : undefined, 4),
            1,
          );
          if (!callId?.length) throw invalidReplayError();
          if (toolCallIds.delete(Buffer.from(callId).toString("utf8"))) size.tools--;
        }
        continue;
      }
      const planner =
        row.step_payload instanceof Uint8Array ? protoBytes(row.step_payload, 20) : undefined;
      const fields = planner ? readProtoFields(planner) : null;
      if (!fields) throw invalidReplayError();
      for (const field of fields) {
        if (!(field.value instanceof Uint8Array)) continue;
        if (field.number === 1) {
          const length = Buffer.from(field.value).toString("utf8").length;
          if (length > 0) {
            size.text += length + (hadTextInTurn ? 2 : 0);
            hadTextInTurn = true;
          }
        }
        if (field.number === 3) size.thought += Buffer.from(field.value).toString("utf8").length;
        if (field.number === 7) {
          size.tools++;
          const callId = protoBytes(field.value, 1);
          if (callId?.length) toolCallIds.add(Buffer.from(callId).toString("utf8"));
        }
      }
    }
    return size;
  } finally {
    db.close();
  }
}

/** agy can answer session/load before its replay notifications have drained. */
export function nativeReplayCompletion(expected: ReplaySize): {
  complete: Promise<void>;
  observe: (event: AntigravityAcpEvent) => void;
} {
  const received = {
    users: 0,
    text: 0,
    thought: 0,
    tools: 0,
    usage: false,
    sessionInfo: false,
  };
  let resolve!: () => void;
  const complete = new Promise<void>((done) => {
    resolve = done;
  });
  const expectSessionInfo = expected.sessionInfo ?? true;
  const check = () => {
    if (
      received.users === expected.users &&
      received.text === expected.text &&
      received.thought === expected.thought &&
      received.tools === expected.tools &&
      received.usage &&
      (!expectSessionInfo || received.sessionInfo)
    )
      resolve();
  };
  check();
  return {
    complete,
    observe(event) {
      if (event.type === "user.text") received.users++;
      if (event.type === "agent.text") received.text += event.text.length;
      if (event.type === "agent.thought") received.thought += event.text.length;
      if (event.type === "tool.call") received.tools++;
      if (event.type === "usage.context") received.usage = true;
      if (event.type === "session.info") received.sessionInfo = true;
      check();
    },
  };
}
