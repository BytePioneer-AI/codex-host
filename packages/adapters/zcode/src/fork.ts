import { randomUUID } from "node:crypto";
import { record, text, snapshotSchema, type NativeSnapshot } from "./protocol.js";
import type { ZcodeConnection } from "./connection.js";
import { ZcodeError } from "./errors.js";
import { withConversation } from "./conversation.js";

/** Only the stable v4 fork preserves workspace files. session/fork rewinds them. */
export async function forkConversation(
  transport: ZcodeConnection,
  source: NativeSnapshot,
  messageId: string,
): Promise<NativeSnapshot> {
  return withConversation(transport, source, async (view) => {
    const row = view.rows.find(
      (row) =>
        row.kind === "assistantText" &&
        row.entityId === messageId &&
        record(row.actions).canFork === true,
    );
    if (!row)
      throw new ZcodeError(
        "checkpointNotFound",
        "ZCode requires a stable completed assistant message to fork",
      );
    const sessionId = source.session.sessionId;
    const ack = record(
      await transport.request("v4/command", {
        commandId: randomUUID(),
        clientId: view.connectionId,
        sessionId,
        type: "forkAssistant",
        payload: { target: { rowId: row.rowId, entityId: messageId } },
        issuedAt: Date.now(),
        baseRevision: view.revision,
        baseLogEpoch: view.logEpoch,
      }),
    );
    const child = text(record(ack.result).sessionId);
    if (ack.status !== "accepted" || !child || child === sessionId)
      throw new ZcodeError(
        ack.status === "stale" ? "sessionBusy" : "nativeFailure",
        `ZCode fork was not accepted: ${text(ack.reasonCode) || text(ack.status)}`,
        ack.status === "stale",
      );
    return snapshotSchema.parse(await transport.request("session/read", { sessionId: child }));
  });
}
