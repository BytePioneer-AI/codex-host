import type { StoredDelegationRecordV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";

import type { DelegationThreadStatus } from "./delegation-types.js";

/**
 * A Delegation record keeps the child's last settled status, so a follow-up Turn on a finished
 * child still reads `completed`. Whatever the Host currently runs wins over that record.
 */
export function delegationChildStatus(
  delegation: Pick<StoredDelegationRecordV1, "childHostThreadId" | "status">,
  activeThreadIds: ReadonlySet<string>,
): DelegationThreadStatus {
  return activeThreadIds.has(delegation.childHostThreadId) ? "running" : delegation.status;
}

export interface DelegationChildRow {
  delegation: StoredDelegationRecordV1;
  /** External Thread record; native Codex children have none. */
  record: StoredThreadRecordV1 | undefined;
  status: DelegationThreadStatus;
}

/** Joins Delegation records with Thread records and live run state, grouped by parent. */
export function delegationChildRows(input: {
  delegations: readonly StoredDelegationRecordV1[];
  records: readonly StoredThreadRecordV1[];
  activeThreadIds: readonly string[];
}): Map<string, DelegationChildRow[]> {
  const byId = new Map(input.records.map((record) => [record.hostThreadId, record] as const));
  const active = new Set(input.activeThreadIds);
  const byParent = new Map<string, DelegationChildRow[]>();
  for (const delegation of input.delegations) {
    const parent = delegation.parentHostThreadId;
    if (!parent) continue;
    let rows = byParent.get(parent);
    if (!rows) byParent.set(parent, (rows = []));
    rows.push({
      delegation,
      record: byId.get(delegation.childHostThreadId),
      status: delegationChildStatus(delegation, active),
    });
  }
  return byParent;
}
