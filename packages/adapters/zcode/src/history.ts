import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import type {
  HistoricalTurnOutcome,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import { ZCODE_ID, encodeModel, sessionState } from "./models.js";
import { projectPart } from "./projection.js";
import {
  record,
  text,
  type NativeEvent,
  type NativeMessage,
  type NativeSnapshot,
} from "./protocol.js";

export function nativeTurnRef(sessionId: string, messageId: string) {
  return nativeTurnRefSchema.parse({
    harnessId: ZCODE_ID,
    nativeSessionId: sessionId,
    nativeTurnKey: messageId,
    formatVersion: 1,
  });
}
export function eventOutcome(event: NativeEvent): HistoricalTurnOutcome {
  const p = event.payload ?? {};
  if (event.type === "turn.failed")
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: sanitizeDiagnosticTail(text(record(p.error).message)) || "ZCode turn failed",
        retryable: record(p.error).retryable === true,
      },
    };
  if (p.resultType === "cancelled") return { status: "cancelled" };
  if (p.resultType === "success") return { status: "succeeded" };
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: `ZCode turn ended with ${text(p.resultType) || "an unknown result"}`,
      retryable: false,
    },
  };
}
function messageOutcome(message: NativeMessage | undefined): HistoricalTurnOutcome {
  if (!message) return { status: "unknown", reason: "No native terminal result is available" };
  if (message.info.error) {
    const error = record(message.info.error.data);
    if (/abort|cancel|interrupt/iu.test(text(message.info.error.name) + text(error.code)))
      return { status: "cancelled" };
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: sanitizeDiagnosticTail(text(error.message)) || "ZCode turn failed",
        retryable: false,
      },
    };
  }
  if (
    ["stop", "end_turn", "stop_sequence"].includes(message.info.finish ?? "") &&
    message.info.time.completed !== undefined
  )
    return { status: "succeeded" };
  return { status: "unknown", reason: "The persisted ZCode turn has no terminal result" };
}
export function history(
  snapshot: NativeSnapshot,
  events: readonly NativeEvent[] = [],
  locator?: JsonObject,
): HostThreadSnapshot {
  const outcomes = new Map<string, { outcome: HistoricalTurnOutcome; completedAtMs: number }>();
  const nativeKeys = new Map<string, string>();
  for (const event of events) {
    if (event.type === "turn.started" && event.turnId && text(event.payload?.messageId))
      nativeKeys.set(event.turnId, text(event.payload?.messageId));
    const key = event.turnId ? nativeKeys.get(event.turnId) : undefined;
    if (key && (event.type === "turn.completed" || event.type === "turn.failed"))
      outcomes.set(key, { outcome: eventOutcome(event), completedAtMs: event.timestamp });
  }
  const turns: HostTurnSnapshot[] = [];
  let current: { user: NativeMessage; assistants: NativeMessage[] } | undefined;
  const finish = () => {
    if (!current) return;
    const { user, assistants } = current,
      last = assistants.findLast((message) => message.info.semantics?.kind !== "timeline_event"),
      terminal = outcomes.get(user.info.messageId);
    const outcome = terminal?.outcome ?? messageOutcome(last);
    const checkpoint =
      outcome.status === "succeeded" && last
        ? nativeCheckpointRefSchema.parse({
            harnessId: ZCODE_ID,
            nativeSessionId: snapshot.session.sessionId,
            formatVersion: 1,
            checkpointId: last.info.messageId,
          })
        : undefined;
    const completedAtMs = last?.info.time.completed ?? terminal?.completedAtMs;
    turns.push({
      nativeTurnRef: nativeTurnRef(snapshot.session.sessionId, user.info.messageId),
      ...(checkpoint ? { checkpoint } : {}),
      input: user.parts
        .filter((part) => part.type === "text" && part.ignored !== true)
        .map((part) => ({ type: "text", text: text(part.text) })),
      items: assistants.flatMap((message) =>
        message.parts.flatMap((part) =>
          projectPart(part, snapshot.session.workspace.workspacePath),
        ),
      ),
      outcome,
      ...(user.info.model
        ? {
            model: encodeModel(
              user.info.model,
              locator?.backend === "desktop" ? "desktop" : "stdio",
            ),
          }
        : {}),
      startedAtMs: user.info.time.created,
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    });
  };
  for (const message of snapshot.messages) {
    if (message.info.role === "user") {
      if (
        (message.info.synthetic &&
          message.info.semantics?.transcriptVisibility !== "visible" &&
          message.info.semantics?.uiVisibility !== "visible") ||
        message.info.visibility === "model-only" ||
        message.info.semantics?.transcriptVisibility === "hidden" ||
        ["fork_notice", "rewind_notice", "compact_summary", "timeline_event"].includes(
          text(message.info.semantics?.kind),
        )
      )
        continue;
      finish();
      current = { user: message, assistants: [] };
    } else if (current && message.info.semantics?.transcriptVisibility !== "hidden")
      current.assistants.push(message);
  }
  finish();
  return { turns, state: sessionState(snapshot, locator) };
}
