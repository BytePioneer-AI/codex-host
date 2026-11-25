import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { nativeFileChanges } from "../src/file-changes.js";
const events: SessionEvent[] = JSON.parse(
  readFileSync(new URL("./fixtures/file-change.json", import.meta.url), "utf8"),
);
const completion = events.find(
  (event): event is Extract<SessionEvent, { type: "tool.execution_complete" }> =>
    event.type === "tool.execution_complete",
);
if (!completion) throw new Error("Missing native file-change fixture");
const data = completion.data;
describe("Copilot committed native file changes", () => {
  it("preserves the native unified diff after a confirmed mutation", () => {
    const changes = nativeFileChanges(data);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "/workspace/probe.txt", kind: "add" });
    expect(changes[0]?.unifiedDiff).toBe(data.result?.detailedContent?.trimStart());
  });
  it("does not infer actual edits from requested paths or unrelated diff text", () => {
    expect(nativeFileChanges({ ...data, fileEdits: [] })).toEqual([]);
    expect(
      nativeFileChanges({ ...data, fileEdits: [{ kind: "create", path: "/other.txt" }] }),
    ).toEqual([]);
    expect(nativeFileChanges({ ...data, result: { content: "added file" } })).toEqual([]);
  });
});
