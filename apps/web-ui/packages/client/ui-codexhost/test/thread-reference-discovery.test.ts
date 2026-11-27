import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { InputTriggerSource } from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { describe, expect, it, vi } from "vitest";
import {
  NON_EMPTY_QUERY_THREAD_LIMIT,
  registerThreadReferenceDiscovery,
} from "../src/client/thread-reference-discovery.ts";

interface MockSessionRow {
  id: SessionId;
  cwd: string;
  title: string;
  updatedAt: number;
  blank: boolean;
  projectionValues: {
    threadReference: {
      threadId: string;
      hostId: string;
    };
  };
}

function makeRow(index: number, overrides: Partial<MockSessionRow> = {}): MockSessionRow {
  const id = `session-${index}` as SessionId;
  return {
    id,
    cwd: `/repo/work-${index}`,
    title: `Task alpha ${index}`,
    updatedAt: 1000 + index,
    blank: false,
    projectionValues: {
      threadReference: {
        threadId: `thread-${String(index).padStart(3, "0")}`,
        hostId: "local",
      },
    },
    ...overrides,
  };
}

function createDiscoveryHarness(rows: MockSessionRow[], archived: SessionId[] = []) {
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const sessionsList = createSnapshotStore({
    ids: rows.map((row) => row.id),
    byId,
  });
  const workspacesList = createSnapshotStore({
    items: [
      {
        title: "Workspace One",
        sessionIds: rows.slice(0, 5).map((row) => row.id),
      },
    ],
    archivedSessionIds: archived,
  });
  let registered: InputTriggerSource | undefined;
  const ctx = {
    locale: { bind: () => (key: string) => key },
    sessions: {
      list: sessionsList,
      subagentAddress: () => undefined,
      refresh: vi.fn(async () => {}),
    },
    workspaces: {
      list: workspacesList,
    },
    inputTriggers: {
      registerSource: (source: InputTriggerSource) => {
        registered = source;
        return () => {};
      },
    },
    effect: (fn: () => void) => fn(),
  } as unknown as Context;

  registerThreadReferenceDiscovery(ctx);
  if (!registered) throw new Error("Expected thread reference source to register");
  return { source: registered, sessionsList, workspacesList };
}

describe("registerThreadReferenceDiscovery caching and limits", () => {
  it("caps empty queries at 5 and non-empty queries at NON_EMPTY_QUERY_THREAD_LIMIT", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => makeRow(i));
    const currentId = rows[0]!.id;
    const archivedId = rows[39]!.id;
    const { source } = createDiscoveryHarness(rows, [archivedId]);
    const signal = new AbortController().signal;
    const epoch = {};

    const emptyResults = await source.candidates(
      { sessionId: currentId },
      { query: "", quoted: false, position: "inline", drilled: false, menuEpoch: epoch, signal },
    );
    expect(emptyResults).toHaveLength(5);
    expect(emptyResults.map((item) => item.name)).toEqual([
      "session-38",
      "session-37",
      "session-36",
      "session-35",
      "session-34",
    ]);

    const searchResults = await source.candidates(
      { sessionId: currentId },
      {
        query: "alpha",
        quoted: false,
        position: "inline",
        drilled: false,
        menuEpoch: epoch,
        signal,
      },
    );
    expect(searchResults).toHaveLength(NON_EMPTY_QUERY_THREAD_LIMIT);
    expect(searchResults.some((item) => item.name === currentId)).toBe(false);
    expect(searchResults.some((item) => item.name === archivedId)).toBe(false);
  });

  it("reuses the derived index across queries on unchanged snapshots and invalidates on snapshot update", async () => {
    const rows = [makeRow(0), makeRow(1), makeRow(2)];
    const titleReads = vi.fn();
    Object.defineProperty(rows[1]!, "title", {
      enumerable: true,
      get() {
        titleReads();
        return "Cached Title";
      },
    });
    const { source, sessionsList } = createDiscoveryHarness(rows);
    const signal = new AbortController().signal;
    const epoch = {};

    const first = await source.candidates(
      { sessionId: rows[0]!.id },
      {
        query: "cached",
        quoted: false,
        position: "inline",
        drilled: false,
        menuEpoch: epoch,
        signal,
      },
    );
    expect(first).toHaveLength(1);
    const readsAfterFirst = titleReads.mock.calls.length;

    // Repeated query against the same snapshot hits the cached derived index.
    const second = await source.candidates(
      { sessionId: rows[0]!.id },
      {
        query: "title",
        quoted: false,
        position: "inline",
        drilled: false,
        menuEpoch: epoch,
        signal,
      },
    );
    expect(second).toHaveLength(1);
    expect(titleReads.mock.calls.length).toBe(readsAfterFirst);

    // Updating the sessions snapshot rebuilds the index and surfaces the new thread.
    const added = makeRow(3, {
      title: "Fresh Thread",
      updatedAt: 9999,
      projectionValues: {
        threadReference: {
          threadId: "thread-003",
          hostId: "local",
        },
      },
    });
    sessionsList.set({
      ids: [...rows.map((r) => r.id), added.id],
      byId: { ...sessionsList.getSnapshot().byId, [added.id]: added },
    });

    const third = await source.candidates(
      { sessionId: rows[0]!.id },
      {
        query: "fresh",
        quoted: false,
        position: "inline",
        drilled: false,
        menuEpoch: epoch,
        signal,
      },
    );
    expect(third.map((item) => item.label)).toEqual(["Fresh Thread"]);
  });
});
