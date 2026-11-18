import type { AntigravityAcpEvent } from "./acp-types.js";
import { AntigravityTransportError } from "./acp-types.js";
import { nativeConversationDbPath } from "./fork.js";
import { readProtoFields } from "./native-protobuf.js";

interface ReplaySize {
  users: number;
  text: number;
  thought: number;
  tools: number;
}

function countWithoutWhitespace(value: string): number {
  return value.replace(/\s+/gu, "").length;
}

/** Native user boundaries and planner payload sizes, including the final reply. */
export async function readNativeReplaySize(sessionId: string, home: string): Promise<ReplaySize> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(sessionId))
    throw new AntigravityTransportError("protocolError", "Invalid native Session ID");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(nativeConversationDbPath(sessionId, home), { readOnly: true });
  const size: ReplaySize = { users: 0, text: 0, thought: 0, tools: 0 };
  try {
    for (const row of db
      .prepare("SELECT step_type, step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx")
      .iterate()) {
      if (row.step_type === 14) {
        size.users++;
        continue;
      }
      const planner =
        row.step_payload instanceof Uint8Array
          ? readProtoFields(row.step_payload)?.find((field) => field.number === 20)?.value
          : undefined;
      const fields = planner instanceof Uint8Array ? readProtoFields(planner) : null;
      if (!fields)
        throw new AntigravityTransportError(
          "protocolError",
          "Cannot verify Antigravity history replay",
        );
      for (const field of fields) {
        if (!(field.value instanceof Uint8Array)) continue;
        if (field.number === 1)
          size.text += countWithoutWhitespace(Buffer.from(field.value).toString("utf8"));
        if (field.number === 3)
          size.thought += countWithoutWhitespace(Buffer.from(field.value).toString("utf8"));
        if (field.number === 7) size.tools++;
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
  const received: ReplaySize = { users: 0, text: 0, thought: 0, tools: 0 };
  let resolve!: () => void;
  const complete = new Promise<void>((done) => {
    resolve = done;
  });
  const check = () => {
    if (
      received.users === expected.users &&
      received.text === expected.text &&
      received.thought === expected.thought &&
      received.tools === expected.tools
    )
      resolve();
  };
  check();
  return {
    complete,
    observe(event) {
      if (event.type === "user.text") received.users++;
      if (event.type === "agent.text") received.text += countWithoutWhitespace(event.text);
      if (event.type === "agent.thought") received.thought += countWithoutWhitespace(event.text);
      if (event.type === "tool.call") received.tools++;
      check();
    },
  };
}
