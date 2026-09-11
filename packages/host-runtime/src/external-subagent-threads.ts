import { createHash, randomUUID } from "node:crypto";

import type { HostSubagentState, HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { projectHistoricalTurn, type JsonObject } from "@codexhost/protocol-core";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";

import type { ExternalThreadStore } from "./external-thread-repository.js";

/** The same native child must have one Host identity in live events and restored history. */
export async function materializeExternalSubagent(
  store: ExternalThreadStore,
  parent: StoredThreadRecordV1,
  child: HostSubagentState,
): Promise<StoredThreadRecordV1 | null> {
  if (!child.nativeSubagentId || !parent.nativeSessionRef || parent.state !== "ready") return null;
  const nativeRef = parent.nativeSessionRef;
  const existing = (await store.listThreads()).find(
    (record) =>
      record.subagent?.parentHostThreadId === parent.hostThreadId &&
      record.subagent.nativeSubagentId === child.nativeSubagentId &&
      record.harnessId === parent.harnessId &&
      record.nativeSessionRef?.nativeSessionId === nativeRef.nativeSessionId,
  );
  if (existing?.state === "ready") return existing;

  // MappingStore deduplicates create requests atomically, including overlapping
  // live event projection and history hydration. Reuse legacy records above.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        parent.hostThreadId,
        parent.harnessId,
        nativeRef.nativeSessionId,
        child.nativeSubagentId,
      ]),
    )
    .digest("hex");
  const provisional =
    existing ??
    (await store.createProvisional({
      hostThreadId: hostThreadIdSchema.parse(randomUUID()),
      createRequestId: `subagent:${key}`,
      harnessId: parent.harnessId,
      cwd: parent.cwd,
      title: child.description,
      transportModelId: parent.transportModelId,
      ephemeral: parent.ephemeral,
      historyMode: "paginated",
      subagent: {
        parentHostThreadId: parent.hostThreadId,
        nativeSubagentId: child.nativeSubagentId,
        ...(child.role ? { role: child.role } : {}),
      },
    }));
  return provisional.state === "ready"
    ? provisional
    : store.commitReady({
        hostThreadId: provisional.hostThreadId,
        nativeSessionRef: nativeRef,
      });
}

export async function projectExternalSnapshot(
  store: ExternalThreadStore,
  record: StoredThreadRecordV1,
  snapshot: HostThreadSnapshot,
): Promise<JsonObject[]> {
  const turns: JsonObject[] = [];
  for (const [index, turn] of snapshot.turns.entries()) {
    const mapping = record.turnMappings[index];
    if (!mapping) throw new Error("External Snapshot mapping is incomplete");
    const items = await Promise.all(
      turn.items.map(async (entry) => {
        if (entry.item.type !== "subagentDelegation") return entry;
        const subagents = await Promise.all(
          entry.item.subagents.map(async (child) => {
            const stored = await materializeExternalSubagent(store, record, child);
            return stored ? { ...child, subagentId: stored.hostThreadId } : child;
          }),
        );
        return { ...entry, item: { ...entry.item, subagents } };
      }),
    );
    turns.push(
      projectHistoricalTurn({
        threadId: record.hostThreadId,
        turnId: mapping.hostTurnId,
        cwd: record.cwd,
        snapshot: { ...turn, items },
      }),
    );
  }
  return turns;
}
