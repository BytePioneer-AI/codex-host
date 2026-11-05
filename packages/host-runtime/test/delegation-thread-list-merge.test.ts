import { describe, expect, it, vi } from "vitest";

import { mergeThreadListPages } from "../src/delegation-thread-list-merge.js";
import type { DelegationThreadListItem, ThreadListInput } from "../src/delegation-types.js";

const input: ThreadListInput = { limit: 2, sort: "created-desc" };
const row = (threadId: string): DelegationThreadListItem => ({
  threadId,
  harnessId: "codex",
  status: "completed",
  deepLink: `codex://threads/${threadId}`,
});
const compare = (a: DelegationThreadListItem, b: DelegationThreadListItem) =>
  a.threadId.localeCompare(b.threadId);

describe("merged Thread list source boundaries", () => {
  it("follows empty nonterminal pages without losing another source's head", async () => {
    const sparse = vi.fn(async (request: ThreadListInput) =>
      request.cursor
        ? { threads: [row("a")], nextCursor: null }
        : { threads: [], nextCursor: "after-empty" },
    );
    const other = vi.fn(async () => ({ threads: [row("b")], nextCursor: null }));
    expect(await mergeThreadListPages([sparse, other], input, compare, "generation")).toEqual({
      threads: [row("a"), row("b")],
      nextCursor: null,
    });
    expect(sparse).toHaveBeenCalledTimes(2);
    expect(sparse).toHaveBeenLastCalledWith({ ...input, limit: 1, cursor: "after-empty" });
    expect(other).toHaveBeenCalledOnce();
  });

  it("bounds empty pages even when the backend keeps changing its cursor", async () => {
    let page = 0;
    const source = vi.fn(async () => ({ threads: [], nextCursor: String(++page) }));
    await expect(
      mergeThreadListPages([source], input, compare, "generation"),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Thread list exceeded its request bound",
    });
    expect(source).toHaveBeenCalledTimes(256);
  });

  it.each(["oversized", "non-progressing"] as const)("rejects a %s source page", async (kind) => {
    const source = vi.fn(async (request: ThreadListInput) =>
      kind === "oversized"
        ? { threads: [row("a"), row("b")], nextCursor: null }
        : { threads: [], nextCursor: request.cursor ?? "same" },
    );
    await expect(
      mergeThreadListPages([source], input, compare, "generation"),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Thread list returned an invalid page",
    });
    expect(source.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each([0, 101, NaN])("rejects limit %s without contacting a source", async (limit) => {
    const source = vi.fn(async () => ({ threads: [], nextCursor: null }));
    await expect(
      mergeThreadListPages([source], { ...input, limit }, compare, "generation"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(source).not.toHaveBeenCalled();
  });
});
