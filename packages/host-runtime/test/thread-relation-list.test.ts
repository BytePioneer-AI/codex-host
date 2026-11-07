import type { StoredDelegationRecordV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { listThreadRelations, type ThreadRelationSource } from "../src/thread-relation-list.js";

const id = (value: string): HostThreadId => hostThreadIdSchema.parse(value);

function sourceWith(options: {
  records?: Record<string, Partial<StoredThreadRecordV1>>;
  delegations?: Record<string, string>;
}): ThreadRelationSource {
  return {
    find: vi.fn(async (threadId: HostThreadId) => {
      const record = options.records?.[threadId];
      return record ? ({ hostThreadId: threadId, ...record } as StoredThreadRecordV1) : null;
    }),
    getDelegationByChild: vi.fn(async (threadId: HostThreadId) => {
      const parent = options.delegations?.[threadId];
      return parent
        ? ({
            childHostThreadId: threadId,
            parentHostThreadId: id(parent),
          } as StoredDelegationRecordV1)
        : null;
    }),
  };
}

describe("listThreadRelations", () => {
  it("reports Delegation parents before Fork sources and keeps request order", async () => {
    const source = sourceWith({
      records: {
        delegated: { forkSource: { hostThreadId: id("fork-parent") } as never },
        forked: { forkSource: { hostThreadId: id("fork-parent") } as never },
        external: {},
      },
      delegations: { delegated: "delegation-parent", "codex-child": "external" },
    });

    await expect(
      listThreadRelations({
        threadIds: [id("delegated"), id("forked"), id("external"), id("codex-child"), id("plain")],
        source,
      }),
    ).resolves.toEqual({
      threads: [
        {
          threadId: "delegated",
          owner: "external",
          parent: { threadId: "delegation-parent", relation: "delegation" },
        },
        {
          threadId: "forked",
          owner: "external",
          parent: { threadId: "fork-parent", relation: "fork" },
        },
        { threadId: "external", owner: "external", parent: null },
        {
          threadId: "codex-child",
          owner: "codex",
          parent: { threadId: "external", relation: "delegation" },
        },
        { threadId: "plain", owner: "codex", parent: null },
      ],
    });
  });

  it("leaves Subagents, shared Threads, and self references at the top level", async () => {
    const source = sourceWith({
      records: {
        subagent: {
          subagent: { parentHostThreadId: id("parent") } as never,
          forkSource: { hostThreadId: id("parent") } as never,
        },
        self: { forkSource: { hostThreadId: id("self") } as never },
      },
      delegations: { shared: "parent" },
    });

    await expect(
      listThreadRelations({
        threadIds: [id("subagent"), id("shared"), id("self")],
        source,
        sharedThreadIds: new Map([["shared", "peer"]]),
      }),
    ).resolves.toEqual({
      threads: [
        { threadId: "subagent", owner: "external", parent: null },
        { threadId: "shared", owner: "external", parent: null },
        { threadId: "self", owner: "external", parent: null },
      ],
    });
    expect(source.getDelegationByChild).not.toHaveBeenCalledWith("shared");
  });
});
