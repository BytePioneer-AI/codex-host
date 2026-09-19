import { randomUUID } from "node:crypto";
import type { ZcodeConnection } from "./connection.js";
import { record, text, type NativeSnapshot } from "./protocol.js";
import { ZcodeError } from "./errors.js";

interface ConversationView {
  rows: Record<string, unknown>[];
  revision: number;
  logEpoch: string;
  connectionId: string;
}
/** v4 queries use a revision and epoch from an owned subscription. */
export async function withConversation<T>(
  transport: ZcodeConnection,
  source: NativeSnapshot,
  work: (view: ConversationView) => Promise<T>,
): Promise<T> {
  const sessionId = source.session.sessionId,
    connectionId = `codexhost-${randomUUID()}`,
    topic = `conversation/${sessionId}`;
  let revision: number | undefined,
    logEpoch = "",
    subscriptionId = "";
  const previous = transport.onMessage;
  transport.onMessage = (message) => {
    if (message.method === "v4/conversation/frame") {
      const snapshot = record(record(record(record(message.params).frame).payload).snapshot);
      if (snapshot.sessionId === sessionId && typeof snapshot.revision === "number") {
        revision = snapshot.revision;
        logEpoch = text(snapshot.logEpoch);
      }
    }
    previous?.(message);
  };
  try {
    const result = record(
      await transport.request("v4/conversation/subscribe", {
        topic,
        connectionId,
        clientMode: "desktop-continuous",
        workspace: source.session.workspace,
      }),
    );
    subscriptionId = text(record(result.ack).subscriptionId);
    const rows: Record<string, unknown>[] = [];
    let beforeRowId: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = record(
        await transport.request("v4/conversation/rowsRange", {
          sessionId,
          clientMode: "desktop-continuous",
          limit: 200,
          ...(beforeRowId !== undefined ? { beforeRowId } : {}),
        }),
      );
      const batch = Array.isArray(result.rows) ? result.rows.map(record) : [];
      rows.unshift(...batch);
      if (result.hasMore !== true) {
        if (revision === undefined || !logEpoch)
          throw new ZcodeError("protocolError", "ZCode did not provide a conversation revision");
        return await work({ rows, revision, logEpoch, connectionId });
      }
      const next = batch
        .map((row) => row.rowId)
        .filter((id): id is number => typeof id === "number")
        .sort((a, b) => a - b)[0];
      if (next === undefined || next === beforeRowId) break;
      beforeRowId = next;
    }
    throw new ZcodeError("protocolError", "ZCode history pagination did not finish");
  } finally {
    transport.onMessage = previous;
    if (subscriptionId)
      await transport
        .request("v4/conversation/unsubscribe", { topic, subscriptionId, connectionId })
        .catch(() => undefined);
  }
}
