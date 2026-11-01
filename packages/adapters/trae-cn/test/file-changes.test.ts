import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { projectFileChanges } from "../src/file-changes.js";
import { LiveItems } from "../src/live-items.js";
const { withFileDiffs } = createRequire(import.meta.url)("../assets/companion/diffs.cjs");
const fileDiffs = [
  {
    file_path: "C:\\workspace\\file.txt",
    file_action: "modified",
    before_content: "before\n",
    after_content: "after\n",
  },
];
const message = {
  message_id: "assistant",
  reply_to_message_id: "user",
  role: "assistant",
  status: "completed",
  content: JSON.stringify({
    messages: [
      {
        type: "plan_item",
        plan_item: {
          id: "edit",
          tool_call_info: { name: "Edit", result: { data: { can_show_diff: true } } },
        },
      },
    ],
  }),
};

describe("native message file snapshots", () => {
  it.each(["added", "deleted"])(
    "retains native %s boundaries without reconstructing contents from the filesystem",
    (action) => {
      const item = projectFileChanges({
        ...message,
        fileDiffSourceIds: ["edit"],
        fileDiffs: [
          {
            ...fileDiffs[0],
            file_action: action,
            before_content: action === "added" ? "" : "before\n",
            after_content: action === "deleted" ? "" : "after\n",
          },
        ],
      });
      expect(item?.changes[0]?.kind).toBe(action === "added" ? "add" : "delete");
      expect(item?.changes[0]?.unifiedDiff).toContain(
        action === "added" ? "--- /dev/null" : "+++ /dev/null",
      );
    },
  );
  it("queries exact native ownership and projects one stable completed fileChange", async () => {
    const native = { call: vi.fn(async () => ({ file_diffs: fileDiffs })) };
    const enriched = await withFileDiffs(native, message, "session", "project");
    expect(native.call).toHaveBeenCalledExactlyOnceWith(
      "snapshot",
      "get_message_ai_edit_file_diff_list",
      { project_id: "project", session_id: "session", message_id: "user" },
    );
    const item = projectFileChanges(enriched);
    expect(item).toMatchObject({
      type: "fileChange",
      itemId: "assistant.files",
      sourceItemIds: ["edit.tool"],
      changes: [{ path: "C:/workspace/file.txt", kind: "update" }],
    });
    expect(item?.changes[0]?.unifiedDiff).toContain("-before\n+after\n");
    expect(projectFileChanges(enriched)).toEqual(item);
    if (!item) throw new Error("Missing file change");
    const events: HostEvent[] = [];
    const live = new LiveItems(hostTurnIdSchema.parse("turn"), (e) => events.push(e));
    const snapshots = [{ item, outcome: { status: "succeeded" as const } }];
    live.acceptFileChanges(snapshots);
    live.acceptFileChanges(snapshots);
    live.settle({ status: "succeeded" });
    expect(events.map((e) => e.type)).toEqual(["item.started", "item.completed"]);
  });
  it("never fabricates a diff from empty tool parameters or while the native message is active", async () => {
    const native = { call: vi.fn() };
    expect(projectFileChanges(message)).toBeUndefined();
    await expect(
      withFileDiffs(native, { ...message, status: "in_progress" }, "session", "project"),
    ).resolves.toEqual({ ...message, status: "in_progress" });
    expect(native.call).not.toHaveBeenCalled();
    expect(() =>
      projectFileChanges({
        ...message,
        fileDiffs: [{ ...fileDiffs[0], before_content: undefined }],
        fileDiffSourceIds: ["edit"],
      }),
    ).toThrow("complete contents");
  });
  it("keeps native snapshot failures visible and rejects malformed returned content", async () => {
    const native = {
      call: vi
        .fn()
        .mockRejectedValueOnce(new Error("snapshot unavailable"))
        .mockResolvedValueOnce({ file_diffs: [{ file_path: "/file", file_action: "modified" }] }),
    };
    await expect(withFileDiffs(native, message, "session", "project")).rejects.toThrow(
      "snapshot unavailable",
    );
    await expect(withFileDiffs(native, message, "session", "project")).rejects.toThrow(
      "complete contents",
    );
    expect(native.call).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized native bodies explicitly rather than publishing a partial patch", async () => {
    const native = {
      call: vi.fn(async () => ({
        file_diffs: [{ ...fileDiffs[0], after_content: "x".repeat(2 * 1024 * 1024) }],
      })),
    };
    await expect(withFileDiffs(native, message, "session", "project")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(native.call).toHaveBeenCalledOnce();
  });
});
