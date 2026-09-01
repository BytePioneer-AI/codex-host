import { describe, expect, it } from "vitest";

import {
  decorateOfficialCollabSpawnModels,
  formatCollabSpawnModel,
  observeOfficialThreadModels,
  prettyCollabModelLabel,
} from "../src/codex-collab-spawn-model.js";

describe("official collab spawn model labels", () => {
  it("pretty-prints Codex Model slugs the way Desktop does", () => {
    expect(prettyCollabModelLabel("gpt-5")).toBe("GPT-5");
    expect(prettyCollabModelLabel("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
    expect(prettyCollabModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(prettyCollabModelLabel("xai/grok-4.6")).toBe("Grok 4.6");
    expect(prettyCollabModelLabel("Grok 4.6")).toBe("Grok 4.6");
  });

  it("joins Model and reasoning effort for the Subagent row", () => {
    expect(formatCollabSpawnModel("gpt-5.2-codex", "high")).toBe("GPT-5.2 Codex · High");
    expect(formatCollabSpawnModel("Grok 4.6", "high")).toBe("Grok 4.6 · High");
    expect(formatCollabSpawnModel("Grok 4.6 · High", "high")).toBe("Grok 4.6 · High");
    expect(formatCollabSpawnModel("gpt-5.6-sol", "xhigh")).toBe("GPT-5.6 Sol · xHigh");
  });

  it("rewrites official spawnAgent items and fills from the parent Thread", () => {
    const value = {
      method: "item/started",
      params: {
        threadId: "parent-1",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-1",
          receiverThreadIds: ["child-1"],
          model: "gpt-5.2-codex",
          reasoningEffort: "high",
        },
      },
    };
    expect(decorateOfficialCollabSpawnModels(value)).toBe(true);
    expect(value.params.item.model).toBe("GPT-5.2 Codex · High");

    const inherited = {
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "parent-1",
          model: null,
          reasoningEffort: null,
        },
      },
    };
    expect(
      decorateOfficialCollabSpawnModels(inherited, (threadId) =>
        threadId === "parent-1" ? { model: "gpt-5.6-sol", reasoningEffort: "medium" } : undefined,
      ),
    ).toBe(true);
    expect(inherited.params.item.model).toBe("GPT-5.6 Sol · Medium");
  });

  it("observes latest Model from official Thread objects", () => {
    const models = new Map<string, { model?: string; reasoningEffort?: string }>();
    observeOfficialThreadModels(
      {
        method: "thread/started",
        params: {
          thread: {
            id: "parent-1",
            latestModel: "gpt-5.6-sol",
            latestReasoningEffort: "high",
          },
        },
      },
      (threadId, snapshot) => {
        models.set(threadId, { ...models.get(threadId), ...snapshot });
      },
    );
    expect(models.get("parent-1")).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });
});
