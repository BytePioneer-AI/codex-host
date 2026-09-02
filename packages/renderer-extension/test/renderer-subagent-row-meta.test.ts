import { describe, expect, it } from "vitest";

import {
  formatSubagentRowMeta,
  prettySubagentModel,
  prettySubagentStatus,
  subagentRowMetaFromProps,
} from "../src/renderer-subagent-row-meta.js";

describe("Subagent row meta", () => {
  it("labels Codex Subagent statuses in Traditional Chinese", () => {
    expect(prettySubagentStatus("active")).toBe("進行中");
    expect(prettySubagentStatus("working")).toBe("進行中");
    expect(prettySubagentStatus("waiting")).toBe("等待中");
    expect(prettySubagentStatus("done")).toBe("已完成");
    expect(prettySubagentStatus("failed")).toBe("失敗");
    expect(prettySubagentStatus("interrupted")).toBe("已中斷");
  });

  it("pretty-prints official Codex Model slugs", () => {
    expect(prettySubagentModel("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
    expect(prettySubagentModel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(prettySubagentModel("xai/grok-4.6")).toBe("Grok 4.6");
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

  it("shows official Codex spawn Model, reasoning effort, and status", () => {
    expect(
      formatSubagentRowMeta({
        displayName: "Einstein",
        spawnModel: "gpt-5.2-codex",
        reasoningEffort: "high",
        status: "done",
      }),
    ).toBe("GPT-5.2 Codex · High · 已完成");
    expect(
      formatSubagentRowMeta({
        displayName: "Gibbs",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        status: "active",
      }),
    ).toBe("GPT-5.6 Sol · xHigh · 進行中");
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
  it("shows live working status and the latest Subagent output", () => {
    expect(
      formatSubagentRowMeta({
        displayName: "Inspect implementation",
        spawnModel: "Grok 4.6 · High",
        status: "working",
        output: "still working",
      }),
    ).toBe("Grok 4.6 · High · 進行中 · still working");
    expect(
      subagentRowMetaFromProps({
        backgroundAgent: {
          conversationId: "child-1",
          displayName: "Inspect implementation",
          status: "working",
        },
        items: [
          {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            receiverThreadIds: ["child-1"],
            agentsStates: {
              "child-1": { status: "running", message: "still working" },
            },
          },
        ],
      }),
    ).toMatchObject({
      displayName: "Inspect implementation",
      status: "working",
      output: "still working",
    });
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
