import type { StoredThreadRecordV1, StoredTurnMappingV1 } from "./records.js";

export type SnapshotTurnIdentity = Pick<
  StoredTurnMappingV1,
  "nativeTurnRef" | "nativeCheckpointRef"
>;

const boundary = /^turn-(0|[1-9]\d*)$/u;

export function hasDisplacedAntigravityTurn({
  nativeTurnRef,
  nativeCheckpointRef,
}: SnapshotTurnIdentity): boolean {
  return (
    nativeTurnRef.harnessId === "antigravity" &&
    nativeTurnRef.formatVersion === 1 &&
    nativeCheckpointRef?.formatVersion === 1 &&
    boundary.test(nativeTurnRef.nativeTurnKey) &&
    boundary.test(nativeCheckpointRef.checkpointId) &&
    nativeTurnRef.nativeTurnKey !== nativeCheckpointRef.checkpointId
  );
}

/** Plan a rekey only if replay confirms each displaced boundary without losing another mapping. */
export function planAntigravityTurnRepair(
  record: StoredThreadRecordV1,
  snapshot: readonly SnapshotTurnIdentity[],
): StoredTurnMappingV1[] | undefined {
  const session = record.nativeSessionRef;
  if (
    record.state !== "ready" ||
    record.subagent ||
    session?.harnessId !== "antigravity" ||
    session.formatVersion !== 1
  )
    return;

  const replayed = new Map<string, SnapshotTurnIdentity>();
  for (const identity of snapshot) {
    const { nativeTurnRef: ref, nativeCheckpointRef: checkpoint } = identity;
    if (
      ref.harnessId !== session.harnessId ||
      ref.nativeSessionId !== session.nativeSessionId ||
      replayed.has(ref.nativeTurnKey) ||
      (checkpoint &&
        (checkpoint.harnessId !== session.harnessId ||
          checkpoint.nativeSessionId !== session.nativeSessionId))
    )
      return;
    replayed.set(ref.nativeTurnKey, identity);
  }

  const checkpointClaims = new Map<string, number>();
  for (const { nativeCheckpointRef } of record.turnMappings) {
    if (!nativeCheckpointRef) continue;
    const id = nativeCheckpointRef.checkpointId;
    checkpointClaims.set(id, (checkpointClaims.get(id) ?? 0) + 1);
  }

  const repaired: StoredTurnMappingV1[] = [];
  const keys = new Set<string>();
  for (const mapping of record.turnMappings) {
    const { nativeTurnRef: ref, nativeCheckpointRef: checkpoint } = mapping;
    const displaced = checkpoint && hasDisplacedAntigravityTurn(mapping);
    const key = displaced ? checkpoint.checkpointId : ref.nativeTurnKey;
    const match = replayed.get(key);
    if (!match || match.nativeTurnRef.formatVersion !== ref.formatVersion || keys.has(key)) return;
    if (
      checkpoint &&
      (match.nativeCheckpointRef?.checkpointId !== checkpoint.checkpointId ||
        match.nativeCheckpointRef.formatVersion !== checkpoint.formatVersion ||
        JSON.stringify(match.nativeCheckpointRef.locator) !== JSON.stringify(checkpoint.locator) ||
        (displaced && checkpointClaims.get(key) !== 1))
    )
      return;
    keys.add(key);
    repaired.push(
      displaced ? { ...mapping, nativeTurnRef: { ...ref, nativeTurnKey: key } } : mapping,
    );
  }
  return repaired;
}
