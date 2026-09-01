import { describe, expect, it } from "vitest";

import {
  formatSubagentRowMeta,
  prettySubagentStatus,
  subagentRowMetaFromProps,
} from "../src/renderer-subagent-row-meta.js";

describe("Subagent row meta", () => {
  it("labels Codex Subagent statuses in Traditional Chinese", () => {
    expect(prettySubagentStatus("active")).toBe("進行中");
    expect(prettySubagentStatus("waiting")).toBe("等待中");
    expect(prettySubagentStatus("done")).toBe("已完成");
    expect(prettySubagentStatus("failed")).toBe("失敗");
    expect(prettySubagentStatus("interrupted")).toBe("已中斷");
  });

  it("shows model, effort, and status on one untruncated subtitle", () => {
    expect(
      formatSubagentRowMeta({
        displayName: "Find test run commands",
        spawnModel: "Grok 4.6 · High",
        status: "done",
      }),
    ).toBe("Grok 4.6 · High · 已完成");
    expect(
      formatSubagentRowMeta({
        displayName: "Scan repo entry points",
        spawnModel: "Grok 4.6 · High",
        status: "active",
      }),
    ).toBe("Grok 4.6 · High · 進行中");
  });

  it("reads nested backgroundAgent props used by the artifacts popover", () => {
    expect(
      subagentRowMetaFromProps({
        type: "agent",
        backgroundAgent: {
          conversationId: "child-1",
          displayName: "Find test run commands",
          spawnModel: "Grok 4.6 · High",
          agentRole: "explore",
          status: "done",
        },
      }),
    ).toMatchObject({
      displayName: "Find test run commands",
      spawnModel: "Grok 4.6 · High",
      status: "done",
    });
  });
});
