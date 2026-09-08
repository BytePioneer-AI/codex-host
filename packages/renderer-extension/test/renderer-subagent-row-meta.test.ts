import { describe, expect, it } from "vitest";

import { subagentAvatarIndex, subagentAvatarSrc } from "../src/subagent-avatars.js";
import {
  currentSubagentParentThreadId,
  formatSubagentRowMeta,
  prettySubagentAgentPath,
  prettySubagentEffort,
  prettySubagentModel,
  prettySubagentStatus,
  subagentGroupFromProps,
  subagentRowMetaFromProps,
  subagentRowsFromActivities,
  withResolvedThreadModel,
  withResolvedThreadStatus,
} from "../src/renderer-subagent-row-meta.js";

describe("Subagent row meta", () => {
  it("reads the one active parent Thread id from the Composer marker", () => {
    const marker = {
      getAttribute: () => "parent-1",
    };
    const root = {
      querySelectorAll: () => [marker],
    } as unknown as ParentNode;
    expect(currentSubagentParentThreadId(root)).toBe("parent-1");

    const ambiguous = {
      querySelectorAll: () => [marker, { getAttribute: () => "parent-2" }],
    } as unknown as ParentNode;
    expect(currentSubagentParentThreadId(ambiguous)).toBeUndefined();
  });

  it("picks a stable official Subagent avatar from the conversation id", () => {
    expect(subagentAvatarIndex("01a07e45-ab00-7033-83e4-2f46d9ff3bcd")).toBe(
      subagentAvatarIndex("01a07e45-ab00-7033-83e4-2f46d9ff3bcd"),
    );
    expect(subagentAvatarSrc("child-1", false).startsWith("data:image/svg+xml")).toBe(true);
    expect(subagentAvatarSrc("child-1", true)).not.toBe(subagentAvatarSrc("child-2", true));
  });

  it("labels Codex Subagent statuses in Traditional Chinese", () => {
    expect(prettySubagentStatus("active")).toBe("進行中");
    expect(prettySubagentStatus("waiting")).toBe("等待中");
    expect(prettySubagentStatus("done")).toBe("已完成");
    expect(prettySubagentStatus("failed")).toBe("失敗");
    expect(prettySubagentStatus("interrupted")).toBe("已中斷");
  });

  it("pretty-prints official Codex Model slugs", () => {
    expect(prettySubagentModel("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
    expect(prettySubagentModel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(prettySubagentModel("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(prettySubagentModel("xai/grok-4.6")).toBe("Grok 4.6");
  });

  it("labels official reasoning effort, including Ultra", () => {
    expect(prettySubagentEffort("high")).toBe("High");
    expect(prettySubagentEffort("xhigh")).toBe("xHigh");
    expect(prettySubagentEffort("ultra")).toBe("超高");
  });

  it("shows status, model, and effort on one untruncated subtitle", () => {
    expect(
      formatSubagentRowMeta({
        displayName: "Find test run commands",
        spawnModel: "Grok 4.6 · High",
        status: "done",
      }),
    ).toBe("已完成 · Grok 4.6 · High");
    expect(
      formatSubagentRowMeta({
        displayName: "Scan repo entry points",
        spawnModel: "Grok 4.6 · High",
        status: "active",
      }),
    ).toBe("進行中 · Grok 4.6 · High");
  });

  it("shows official Codex spawn Model, reasoning effort, and status", () => {
    expect(
      formatSubagentRowMeta({
        displayName: "Einstein",
        spawnModel: "gpt-5.2-codex",
        reasoningEffort: "high",
        status: "done",
      }),
    ).toBe("已完成 · GPT-5.2 Codex · High");
    expect(
      formatSubagentRowMeta({
        displayName: "Gibbs",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        status: "active",
      }),
    ).toBe("進行中 · GPT-5.6 Sol · xHigh");
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

  it("joins official collabAgentToolCall Model and effort onto the matching row", () => {
    expect(
      subagentRowMetaFromProps({
        backgroundAgent: {
          conversationId: "child-1",
          displayName: "Einstein",
          spawnModel: "gpt-5.2-codex",
          status: "done",
        },
        items: [
          {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            model: "gpt-5.2-codex",
            reasoningEffort: "high",
            receiverThreadIds: ["child-1"],
          },
        ],
      }),
    ).toMatchObject({
      displayName: "Einstein",
      spawnModel: "gpt-5.2-codex",
      reasoningEffort: "high",
      status: "done",
    });
  });

  it("expands official v2 collapsed backgroundAgents into named rows", () => {
    expect(
      subagentGroupFromProps({
        backgroundAgents: [
          {
            conversationId: "child-1",
            displayName: "Einstein",
            showInlineActivity: true,
            spawnModel: null,
            status: "done",
          },
          {
            conversationId: "child-2",
            displayName: "Gibbs",
            showInlineActivity: true,
            spawnModel: null,
            status: "done",
          },
          {
            conversationId: "child-3",
            displayName: "Bohr",
            showInlineActivity: true,
            spawnModel: null,
            status: "done",
          },
        ],
      }).map((row) => row.displayName),
    ).toEqual(["Einstein", "Gibbs", "Bohr"]);
  });

  it("turns official subAgentActivity items into named running rows", () => {
    expect(prettySubagentAgentPath("/root/workflow_summary_v2")).toBe("Workflow summary v2");
    expect(
      subagentRowsFromActivities([
        {
          type: "subAgentActivity",
          kind: "started",
          agentPath: "/root/workflow_summary_v2",
          agentThreadId: "child-1",
        },
        {
          type: "subAgentActivity",
          kind: "started",
          agentPath: "/root/explore_repo_map_v2",
          agentThreadId: "child-2",
        },
        {
          type: "subAgentActivity",
          kind: "completed",
          agentPath: "/root/explore_repo_map_v2",
          agentThreadId: "child-2",
        },
      ]),
    ).toEqual([
      {
        displayName: "Workflow summary v2",
        conversationId: "child-1",
        status: "running",
      },
      {
        displayName: "Explore repo map v2",
        conversationId: "child-2",
        status: "completed",
      },
    ]);
  });

  it("fills official v2 spawnModel gaps from the exact child Thread Model", () => {
    const row = withResolvedThreadModel(
      {
        displayName: "Einstein",
        conversationId: "child-1",
        status: "done",
      },
      { model: "gpt-5.4", reasoningEffort: "high" },
    );
    expect(formatSubagentRowMeta(row)).toBe("已完成 · GPT-5.4 · High");
    expect(
      formatSubagentRowMeta(
        withResolvedThreadModel(
          {
            displayName: "Repo structure",
            conversationId: "child-2",
            status: "running",
          },
          { model: "gpt-6-astra", reasoningEffort: "ultra" },
        ),
      ),
    ).toBe("進行中 · GPT-6 Astra · 超高");
  });

  it("does not copy an unscoped parent Thread Model into a child row", () => {
    expect(
      subagentRowMetaFromProps({
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        backgroundAgent: {
          conversationId: "child-1",
          displayName: "Einstein",
          status: "done",
        },
      }),
    ).toEqual({
      displayName: "Einstein",
      conversationId: "child-1",
      status: "done",
    });
  });

  it("replaces a stale running label with the exact child failure", () => {
    const row = withResolvedThreadStatus(
      {
        displayName: "Review patch",
        conversationId: "child-1",
        model: "xai/grok-4.6",
        reasoningEffort: "high",
        status: "running",
      },
      "failed",
    );
    expect(formatSubagentRowMeta(row)).toBe("失敗 · Grok 4.6 · High");
  });

  it("does not recurse through arbitrary nested React props", () => {
    const nested = {
      displayName: "Hidden",
      conversationId: "child-1",
      spawnModel: "Grok 4.6 · High",
      status: "done",
    };
    expect(
      subagentRowMetaFromProps({
        children: nested,
        onClick: nested,
        unrelated: nested,
      }),
    ).toBeNull();
  });
});
