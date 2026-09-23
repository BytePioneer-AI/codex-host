import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { PiSubagents, piSubagentId } from "../src/pi-subagents.js";
import { piSubagentArtifact, restorePiSubagents } from "../src/pi-subagent-history.js";
import type { PiSessionHistory } from "../src/pi-history.js";

const status = {
  lifecycleArtifactVersion: 3,
  runId: "run-1",
  sessionId: "parent",
  mode: "workflow",
  state: "complete",
  steps: [{ workflowKey: "review", agent: "reviewer", status: "completed" }],
};

describe("Pi subagent history restoration", () => {
  it("accepts only known artifact versions owned by the exact parent Session", () => {
    expect(piSubagentArtifact(status, "run-1", "parent")?.[0]?.children).toEqual([
      { id: "review", kind: "step", label: "reviewer", state: "complete" },
    ]);
    expect(piSubagentArtifact(status, "run-1", "foreign")).toBeNull();
    expect(piSubagentArtifact(status, "wrong-run", "parent")).toBeNull();
    expect(
      piSubagentArtifact({ ...status, lifecycleArtifactVersion: 4 }, "run-1", "parent"),
    ).toBeNull();
    expect(
      piSubagentArtifact(
        { ...status, steps: [{ ...status.steps[0], status: "future" }] },
        "run-1",
        "parent",
      ),
    ).toBeNull();
  });

  it("restores native receipts without events and gracefully skips deleted or foreign artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-history-"));
    try {
      const asyncDir = path.join(dir, "run-1");
      await mkdir(asyncDir);
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify(status));
      const result = {
        role: "toolResult",
        toolName: "subagent",
        isError: false,
        details: { mode: "workflow", asyncId: "run-1", asyncDir },
      };
      const history: PiSessionHistory = {
        leafId: "result",
        entries: [{ id: "result", parentId: null, type: "message", message: result }],
      };
      const emit = vi.fn();
      const observer = new PiSubagents(emit);
      await restorePiSubagents(history, "foreign", observer);
      expect(observer.project("subagent", result, hostItemIdSchema.parse("item"))).toBeNull();
      await restorePiSubagents(history, "parent", observer);
      expect(observer.project("subagent", result, hostItemIdSchema.parse("item"))).toMatchObject({
        subagents: [
          {
            nativeSubagentId: piSubagentId({ runId: "run-1", childId: "review" }),
            status: "completed",
          },
        ],
      });
      expect(emit).not.toHaveBeenCalled();
      await rm(path.join(asyncDir, "status.json"));
      await expect(
        restorePiSubagents(history, "parent", new PiSubagents(emit)),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
