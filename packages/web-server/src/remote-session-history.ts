import { z } from "zod";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import type { ChThread, ChTurn } from "./ch-thread-view.ts";
import type { RemoteControlsSnapshot } from "./remote-session-controls.ts";
import { RpcError } from "./transport.ts";

export const remoteThreadRowSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string(),
    modelProvider: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    status: z.object({ type: z.string() }),
  })
  .passthrough();

const snapshotSchema = z.object({
  result: z.object({
    thread: remoteThreadRowSchema.extend({
      turns: z.array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            items: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
          })
          .passthrough(),
      ),
    }),
  }),
  epoch: z.string().min(1),
  // Optional controls do not determine whether the native history is readable.
  nativeSettings: z.unknown().optional(),
  configuration: z.unknown().optional(),
  inspection: z.unknown().optional(),
  harness: z.unknown().optional(),
  interactionsAvailable: z.boolean().optional(),
  requests: z.array(
    z.object({
      id: z.union([z.string(), z.number().int()]),
      method: z.string(),
      params: z.record(z.string(), z.unknown()),
    }),
  ),
});
const historyPageSchema = snapshotSchema.extend({ nextCursor: z.string().min(1).nullable() });

export interface RemotePendingRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}
export interface RemoteHistorySnapshot {
  result: { thread: ChThread };
  epoch: string;
  fullReadAt: number;
  requests: RemotePendingRequest[];
  configuration?: RemoteControlsSnapshot["configuration"];
  inspection?: RemoteControlsSnapshot["inspection"];
  harness?: RemoteControlsSnapshot["harness"];
  interactionsAvailable?: boolean;
}

type Read = Extract<RemoteSessionOperation, { kind: "read" }>;
type Previous = {
  epoch: string;
  fullReadAt: number;
  owner?: "codex" | "external" | undefined;
  thread: Pick<ChThread, "turns" | "historyMode" | "parentThreadId" | "canAcceptDirectInput">;
};

// Parsed Turns are retained by identity until a fresh native snapshot replaces them.
// Weak keys release the byte counts with the corresponding history view.
const turnBytes = new WeakMap<ChTurn, number>();

function historyBytes(turns: ChTurn[]): number {
  let bytes = 2 + Math.max(0, turns.length - 1);
  for (const turn of turns) {
    let size = turnBytes.get(turn);
    if (size === undefined) {
      size = Buffer.byteLength(JSON.stringify(turn));
      turnBytes.set(turn, size);
    }
    bytes += size;
  }
  return bytes;
}

function settled(turn: ChTurn): boolean {
  return (
    ["completed", "failed", "interrupted"].includes(turn.status) &&
    !turn.items.some((item) => item.status === "inProgress" || item.status === "running")
  );
}

/** Reuse a settled native prefix briefly, revalidating it periodically and when work settles. */
export async function readRemoteHistory(
  call: (operation: Read) => Promise<unknown>,
  identity: Pick<Read, "hostId" | "threadId">,
  previous?: Previous,
): Promise<RemoteHistorySnapshot> {
  const invalid = (message: string): never => {
    throw new RpcError("remote/read-failed", message);
  };
  const check = (snapshot: RemoteHistorySnapshot): RemoteHistorySnapshot => {
    if (snapshot.result.thread.id !== identity.threadId)
      invalid("Remote history belongs to a different Thread; refresh and retry.");
    const turns = snapshot.result.thread.turns;
    if (new Set(turns.map((turn) => turn.id)).size !== turns.length)
      invalid("Remote history repeats a Turn; refresh and retry.");
    if (turns.length > 5000 || historyBytes(turns) > 128 * 1024 * 1024)
      throw new RpcError(
        "remote/history-too-large",
        "Remote history exceeds the Web history limit.",
      );
    return snapshot;
  };
  const full = async () => {
    const response = snapshotSchema.parse(await call({ kind: "read", ...identity }));
    return check({ ...response, fullReadAt: Date.now() } as RemoteHistorySnapshot);
  };
  // External snapshots and readonly child transcripts can revise terminal Turns.
  // Their native history remains authoritative even when IDs and statuses are unchanged.
  if (
    !previous ||
    Date.now() - previous.fullReadAt >= 30_000 ||
    previous.owner !== "codex" ||
    previous.thread.historyMode !== "paginated" ||
    previous.thread.parentThreadId ||
    previous.thread.canAcceptDirectInput === false
  )
    return full();

  const known = new Map(previous.thread.turns.map((turn, index) => [turn.id, index]));
  const descending: ChTurn[] = [];
  const seenTurns = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let bytes = 0;
  for (let page = 0; page < 5000; page++) {
    const response = historyPageSchema.parse(
      await call({
        kind: "read",
        ...identity,
        page: {
          cursor,
          ...(page === 0 ? {} : { epoch: previous.epoch }),
          sortDirection: "desc",
          limit: 1,
        },
      }),
    );
    const snapshot = check({
      ...response,
      fullReadAt: previous.fullReadAt,
    } as RemoteHistorySnapshot);
    // A reconnected Host can expose a different history generation; no cached prefix crosses it.
    if (snapshot.epoch !== previous.epoch || snapshot.result.thread.historyMode !== "paginated") {
      if (page !== 0)
        throw new RpcError(
          "remote/connection-changed",
          "Remote connection changed during history refresh; retry the read.",
        );
      return full();
    }
    bytes += historyBytes(snapshot.result.thread.turns);
    if (bytes > 128 * 1024 * 1024)
      throw new RpcError(
        "remote/history-too-large",
        "Remote history exceeds the Web history limit.",
      );
    let overlap: number | undefined;
    for (const turn of snapshot.result.thread.turns) {
      if (seenTurns.has(turn.id)) invalid("Remote history pages overlap; refresh and retry.");
      seenTurns.add(turn.id);
      descending.push(turn);
      overlap = known.get(turn.id);
      if (overlap !== undefined) break;
    }
    if (overlap !== undefined || response.nextCursor === null) {
      const prefix = overlap === undefined ? [] : previous.thread.turns.slice(0, overlap);
      if (prefix.some((turn) => !settled(turn))) return full();
      const previousOverlap = overlap === undefined ? undefined : previous.thread.turns[overlap];
      const refreshedOverlap = descending.at(-1);
      if (
        previousOverlap &&
        refreshedOverlap &&
        !settled(previousOverlap) &&
        settled(refreshedOverlap)
      )
        return full();
      return check({
        ...snapshot,
        result: {
          thread: { ...snapshot.result.thread, turns: [...prefix, ...descending.reverse()] },
        },
      });
    }
    if (snapshot.result.thread.turns.length === 0 || cursors.has(response.nextCursor))
      invalid("Remote history cursor did not advance; refresh and retry.");
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new RpcError("remote/history-too-large", "Remote history exceeds the page limit.");
}
