import type { StoredDelegationRecordV1, StoredThreadSummaryV1 } from "@codexhost/mapping-store";
import { hostThreadIdSchema, THREAD_TREE_NODE_TITLE_MAX_LENGTH } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";

import { readThreadTreeNodes, type ThreadTreeNodeSource } from "../src/thread-tree-nodes.js";

const id = (value: string) => hostThreadIdSchema.parse(value);

function delegation(child: string, target: string, createdAt: string): StoredDelegationRecordV1 {
  return {
    childHostThreadId: child,
    parentHostThreadId: "parent",
    targetHarnessId: target,
    createdAt,
  } as unknown as StoredDelegationRecordV1;
}

function summary(threadId: string, fields: { title?: string; archived?: boolean } = {}) {
  return {
    hostThreadId: threadId,
    harnessId: "pi",
    archived: fields.archived ?? false,
    ...(fields.title !== undefined ? { title: fields.title } : {}),
  } as unknown as StoredThreadSummaryV1;
}

function source(overrides: Partial<ThreadTreeNodeSource> = {}): ThreadTreeNodeSource {
  return {
    listDelegations: async () => [
      delegation("external", "pi", "2026-01-01T00:00:00.000Z"),
      delegation("archived", "pi", "2026-01-02T00:00:00.000Z"),
      delegation("gone", "pi", "2026-01-03T00:00:00.000Z"),
      delegation("official", "codex", "2026-01-04T00:00:00.000Z"),
    ],
    listSummaries: async () => [
      summary("external", { title: "  External task  " }),
      summary("archived", { archived: true }),
    ],
    activeThreadIds: () => [],
    hasPendingQuestion: () => false,
    readOfficialTitle: async () => "Official task",
    listOfficialArchived: async () => new Set<string>(),
    ...overrides,
  };
}

it("describes stored and official Threads in request order and leaves out deleted external Threads", async () => {
  const readOfficialTitle = vi.fn(async (threadId: string) =>
    threadId === "official" ? "Official task" : null,
  );
  const threadIds = ["official", "gone", "archived", "external", "undelegated"].map(id);
  expect(
    await readThreadTreeNodes(
      { threadIds, includeOfficial: true },
      source({ readOfficialTitle, listOfficialArchived: async () => new Set(["official"]) }),
    ),
  ).toEqual({
    threads: [
      {
        threadId: "official",
        harnessId: "codex",
        status: "idle",
        title: "Official task",
        archived: true,
        delegatedAt: "2026-01-04T00:00:00.000Z",
      },
      {
        threadId: "archived",
        harnessId: "pi",
        status: "idle",
        archived: true,
        delegatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        threadId: "external",
        harnessId: "pi",
        status: "idle",
        title: "External task",
        archived: false,
        delegatedAt: "2026-01-01T00:00:00.000Z",
      },
      // Its title could not be read; it is still an official Thread that is not archived.
      { threadId: "undelegated", harnessId: "codex", status: "idle", archived: false },
    ],
  });
  // Only Threads without a Host record are read from the official app-server.
  expect(readOfficialTitle.mock.calls.map(([threadId]) => threadId).sort()).toEqual([
    "official",
    "undelegated",
  ]);
});

it("reports an official Thread without guessing what could not be read", async () => {
  const result = await readThreadTreeNodes(
    { threadIds: [id("official")], includeOfficial: true },
    source({
      readOfficialTitle: async () => {
        throw new Error("official app-server is restarting");
      },
      listOfficialArchived: async () => null,
    }),
  );
  expect(result.threads).toEqual([
    {
      threadId: "official",
      harnessId: "codex",
      status: "idle",
      delegatedAt: "2026-01-04T00:00:00.000Z",
    },
  ]);
});

it("keeps official Threads without reading them unless asked, and reports live state", async () => {
  const readOfficialTitle = vi.fn(async () => "unused");
  const listOfficialArchived = vi.fn(async () => new Set<string>());
  const result = await readThreadTreeNodes(
    { threadIds: ["official", "external", "undelegated"].map(id) },
    source({
      readOfficialTitle,
      listOfficialArchived,
      activeThreadIds: () => ["official", "external"],
      hasPendingQuestion: (threadId) => threadId === "external",
    }),
  );
  expect(readOfficialTitle).not.toHaveBeenCalled();
  expect(listOfficialArchived).not.toHaveBeenCalled();
  expect(result.threads).toEqual([
    {
      threadId: "official",
      harnessId: "codex",
      status: "running",
      delegatedAt: "2026-01-04T00:00:00.000Z",
    },
    // A pending question outranks running.
    expect.objectContaining({ threadId: "external", status: "question" }),
    { threadId: "undelegated", harnessId: "codex", status: "idle" },
  ]);
});

it("bounds titles without splitting a surrogate pair", async () => {
  const title = `${"a".repeat(THREAD_TREE_NODE_TITLE_MAX_LENGTH - 1)}😀`;
  const result = await readThreadTreeNodes(
    { threadIds: [id("external")] },
    source({ listSummaries: async () => [summary("external", { title })] }),
  );
  expect(result.threads[0]?.title).toBe("a".repeat(THREAD_TREE_NODE_TITLE_MAX_LENGTH - 1));
});
