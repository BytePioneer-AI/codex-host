import type { StoredDelegationRecordV1 } from "@codexhost/mapping-store";
import { describe, expect, it } from "vitest";

import { delegationChildRows } from "../src/delegation-children.js";

function delegation(
  child: string,
  parent: string,
  status: StoredDelegationRecordV1["status"],
): StoredDelegationRecordV1 {
  return {
    formatVersion: 1,
    revision: 1,
    delegationId: `delegation-${child}`,
    parentHostThreadId: parent,
    childHostThreadId: child,
    sourceHarnessId: "codex",
    targetHarnessId: "pi",
    status,
    taskDigest: "0".repeat(64),
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  } as StoredDelegationRecordV1;
}

describe("delegationChildRows", () => {
  it("groups children by parent and lets a live Turn override the last settled status", () => {
    const rows = delegationChildRows({
      delegations: [
        delegation("child-a", "parent-1", "completed"),
        delegation("child-b", "parent-1", "failed"),
        delegation("child-c", "parent-2", "running"),
      ],
      records: [],
      // child-a finished once and is running a follow-up Turn now.
      activeThreadIds: ["child-a"],
    });

    expect(
      rows.get("parent-1")?.map(({ delegation, status }) => [delegation.childHostThreadId, status]),
    ).toEqual([
      ["child-a", "running"],
      ["child-b", "failed"],
    ]);
    expect(rows.get("parent-2")?.map(({ status }) => status)).toEqual(["running"]);
  });
});
