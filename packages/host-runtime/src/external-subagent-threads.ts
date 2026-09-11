import { createHash, randomUUID } from "node:crypto";

import type { HostSubagentState, HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { projectHistoricalTurn, type JsonObject } from "@codexhost/protocol-core";
import { hostThreadIdSchema, type NativeSessionRef } from "@codexhost/shared-contracts";

import type { ExternalThreadStore } from "./external-thread-repository.js";

/** Route root-owned observations without confusing siblings, forks or replaced Sessions. */
export function findExternalSubagent(
  records: readonly StoredThreadRecordV1[],
  parent: StoredThreadRecordV1,
  nativeSubagentId: string,
): StoredThreadRecordV1 | undefined {
  if (parent.state !== "ready" || !parent.nativeSessionRef) return undefined;
  const byId = new Map(records.map((record) => [record.hostThreadId, record]));
  const matches = records.filter((record) => {
    if (
      record.hostThreadId === parent.hostThreadId ||
      record.subagent?.nativeSubagentId !== nativeSubagentId
    )
      return false;
    const visited = new Set<string>();
    let current: StoredThreadRecordV1 | undefined = record;
    while (current && !visited.has(current.hostThreadId)) {
      if (
        current.state !== "ready" ||
        current.harnessId !== parent.harnessId ||
        current.nativeSessionRef?.nativeSessionId !== parent.nativeSessionRef?.nativeSessionId
      )
        return false;
      if (current.hostThreadId === parent.hostThreadId) return true;
      visited.add(current.hostThreadId);
      current = current.subagent ? byId.get(current.subagent.parentHostThreadId) : undefined;
    }
    return false;
  });
  // Native IDs must unambiguously address a child within this root's tree.
  return matches.length === 1 ? matches[0] : undefined;
}

function childCreateRequest(
  parent: Pick<StoredThreadRecordV1, "hostThreadId" | "harnessId">,
  nativeRef: NativeSessionRef,
  id: string,
) {
  const key = createHash("sha256")
    .update(JSON.stringify([parent.hostThreadId, parent.harnessId, nativeRef.nativeSessionId, id]))
    .digest("hex");
  return `subagent:${key}`;
}

/** Indexed for current records; legacy metadata is scanned at most once per Snapshot. */
function subagentMaterializer(
  store: ExternalThreadStore,
  parent: StoredThreadRecordV1,
  previousParent?: StoredThreadRecordV1,
) {
  if (
    previousParent &&
    (previousParent.hostThreadId !== parent.hostThreadId ||
      previousParent.harnessId !== parent.harnessId)
  ) {
    throw new Error("Subagent Session replacement must stay in the same Host Thread");
  }
  const previousRef = previousParent?.nativeSessionRef;
  let legacy:
    | Promise<{
        byRequest: Map<string, StoredThreadRecordV1>;
        children: Map<string, StoredThreadRecordV1[]>;
      }>
    | undefined;
  const legacyRecords = () =>
    (legacy ??= store.listThreads().then((records) => {
      const byRequest = new Map<string, StoredThreadRecordV1>();
      const children = new Map<string, StoredThreadRecordV1[]>();
      for (const record of records) {
        if (!record.subagent || record.harnessId !== parent.harnessId || !record.nativeSessionRef)
          continue;
        const owner = {
          hostThreadId: record.subagent.parentHostThreadId,
          harnessId: record.harnessId,
        };
        const key = childCreateRequest(
          owner,
          record.nativeSessionRef,
          record.subagent.nativeSubagentId,
        );
        if (!byRequest.has(key) || record.state === "ready") byRequest.set(key, record);
        const siblings = children.get(owner.hostThreadId) ?? [];
        siblings.push(record);
        children.set(owner.hostThreadId, siblings);
      }
      return { byRequest, children };
    }));
  const rebind = async (
    existing: StoredThreadRecordV1,
    owner: StoredThreadRecordV1,
    visited = new Set<string>(),
  ): Promise<StoredThreadRecordV1> => {
    if (
      !previousRef ||
      !owner.nativeSessionRef ||
      !existing.subagent ||
      visited.has(existing.hostThreadId)
    ) {
      throw new Error("Invalid retained Subagent Session tree");
    }
    visited.add(existing.hostThreadId);
    const rebound = await store.rebindSubagentSession({
      hostThreadId: existing.hostThreadId,
      parentHostThreadId: owner.hostThreadId,
      previousNativeSessionRef: previousRef,
      nativeSessionRef: owner.nativeSessionRef,
      createRequestId: childCreateRequest(
        owner,
        owner.nativeSessionRef,
        existing.subagent.nativeSubagentId,
      ),
    });
    // Retaining a child also retains that child's read-only native descendants.
    for (const descendant of (await legacyRecords()).children.get(existing.hostThreadId) ?? []) {
      if (
        descendant.state === "ready" &&
        descendant.nativeSessionRef?.nativeSessionId === previousRef.nativeSessionId
      ) {
        await rebind(descendant, rebound, visited);
      }
    }
    return rebound;
  };

  return async (child: HostSubagentState): Promise<StoredThreadRecordV1 | null> => {
    if (!child.nativeSubagentId || !parent.nativeSessionRef || parent.state !== "ready")
      return null;
    const nativeRef = parent.nativeSessionRef;
    const createRequestId = childCreateRequest(parent, nativeRef, child.nativeSubagentId);
    const previousRequest =
      previousRef && previousRef.nativeSessionId !== nativeRef.nativeSessionId
        ? childCreateRequest(parent, previousRef, child.nativeSubagentId)
        : undefined;
    let existing = await store.getThreadByCreateRequest(createRequestId);
    if (!existing && previousRequest)
      existing = await store.getThreadByCreateRequest(previousRequest);
    if (!existing) {
      const { byRequest } = await legacyRecords();
      existing =
        byRequest.get(createRequestId) ??
        (previousRequest ? byRequest.get(previousRequest) : undefined) ??
        null;
    }
    if (existing?.state === "ready") {
      if (existing.nativeSessionRef?.nativeSessionId === nativeRef.nativeSessionId) return existing;
      if (!previousRef) throw new Error("Subagent belongs to a different Native Session");
      // Only children retained in a validated rollback Snapshot are rebound. Native
      // Session IDs remain part of ordinary lookup, so later reused IDs cannot
      // accidentally select children removed by a previous rollback.
      return rebind(existing, parent);
    }

    // MappingStore atomically deduplicates overlapping live/history creation.
    const provisional =
      existing ??
      (await store.createProvisional({
        hostThreadId: hostThreadIdSchema.parse(randomUUID()),
        createRequestId,
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
  };
}

/** The same native child must have one Host identity in live events and restored history. */
export async function materializeExternalSubagent(
  store: ExternalThreadStore,
  parent: StoredThreadRecordV1,
  child: HostSubagentState,
): Promise<StoredThreadRecordV1 | null> {
  return subagentMaterializer(store, parent)(child);
}

export async function projectExternalSnapshot(
  store: ExternalThreadStore,
  record: StoredThreadRecordV1,
  snapshot: HostThreadSnapshot,
  previousParent?: StoredThreadRecordV1,
): Promise<JsonObject[]> {
  const materialize = subagentMaterializer(store, record, previousParent);
  const turns: JsonObject[] = [];
  for (const [index, turn] of snapshot.turns.entries()) {
    const mapping = record.turnMappings[index];
    if (!mapping) throw new Error("External Snapshot mapping is incomplete");
    const items = await Promise.all(
      turn.items.map(async (entry) => {
        if (entry.item.type !== "subagentDelegation") return entry;
        const subagents = await Promise.all(
          entry.item.subagents.map(async (child) => {
            const stored = await materialize(child);
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
