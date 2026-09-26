import type { ServiceTransport } from "./transport.js";
import { record, text, type NativeSnapshot } from "./protocol.js";
import { ZcodeError } from "./errors.js";

interface ConversationView {
  rows: Record<string, unknown>[];
  revision: number;
  logEpoch: string;
}
/** Read file/checkpoint facts through an owned native V4 subscription. */
export async function withConversation<T>(
  transport: ServiceTransport,
  source: NativeSnapshot,
  work: (view: ConversationView) => Promise<T>,
): Promise<T> {
  const sessionId = source.session.sessionId;
  const ready = Promise.withResolvers<{ revision: number; logEpoch: string }>();
  let subscriptionId = "";
  const timer = setTimeout(
    () =>
      ready.reject(
        new ZcodeError("protocolError", "ZCode did not provide a conversation revision"),
      ),
    transport.options.timeoutMs ?? 30_000,
  );
  void ready.promise.catch(() => undefined);
  const dispose = await transport.listen("onDynamicConversationFrame", {}, (value) => {
    const snapshot = record(record(record(record(value).frame).payload).snapshot);
    if (
      snapshot.sessionId === sessionId &&
      typeof snapshot.revision === "number" &&
      typeof snapshot.logEpoch === "string"
    )
      ready.resolve({ revision: snapshot.revision, logEpoch: snapshot.logEpoch });
  });
  try {
    const result = record(await transport.request("subscribeConversationV4", { sessionId }));
    subscriptionId = text(record(result.ack).subscriptionId);
    if (!subscriptionId)
      throw new ZcodeError("protocolError", "ZCode subscription has no identity");
    const state = await ready.promise;
    const rows: Record<string, unknown>[] = [];
    let beforeRowId: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const batch = record(
        await transport.request("conversationRowsRangeV4", {
          sessionId,
          limit: 200,
          ...(beforeRowId !== undefined ? { beforeRowId } : {}),
        }),
      );
      if (!Array.isArray(batch.rows))
        throw new ZcodeError("protocolError", "ZCode returned invalid conversation rows");
      const incoming = batch.rows.map(record);
      rows.unshift(...incoming);
      if (batch.hasMore !== true) return await work({ ...state, rows });
      const next = incoming
        .map((row) => row.rowId)
        .filter((id): id is number => typeof id === "number")
        .sort((a, b) => a - b)[0];
      if (next === undefined || next === beforeRowId) break;
      beforeRowId = next;
    }
    throw new ZcodeError("protocolError", "ZCode conversation pagination did not finish");
  } finally {
    clearTimeout(timer);
    if (subscriptionId)
      await transport
        .request("unsubscribeConversationV4", { subscriptionId })
        .catch(() => undefined);
    await dispose().catch(() => undefined);
  }
}
