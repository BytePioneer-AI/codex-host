import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityHistory } from "../src/history.js";

const nativeTurnRef = nativeTurnRefSchema.parse({
  harnessId: "antigravity",
  nativeSessionId: "conversation-1",
  nativeTurnKey: "turn:1",
  formatVersion: 1,
});

describe("Antigravity history sidecar", () => {
  it("restores completed Turns and selection without Host Runtime persistence", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-history-"));
    const environment = { CODEXHOST_DATA_DIR: dataDirectory, CODEXHOST_THREAD_ID: "thread-1" };
    const model = harnessModelRefSchema.parse({ id: "gemini-3.1-pro" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    try {
      const history = await AntigravityHistory.open({
        environment,
        nativeSessionId: "conversation-1",
      });
      history.setSelection(model, thinkingOptionId);
      history.append({
        nativeTurnRef,
        turnInput: [{ type: "text", text: "review auth" }],
        items: [
          {
            item: {
              type: "agentMessage",
              itemId: hostItemIdSchema.parse("assistant-1"),
              text: "Checking auth.",
            },
            outcome: { status: "succeeded" },
          },
        ],
        outcome: { status: "succeeded" },
        model,
      });
      await history.flush();

      const restored = await AntigravityHistory.open({
        environment,
        nativeSessionId: "conversation-1",
      });

      expect(restored.model).toEqual(model);
      expect(restored.thinkingOptionId).toBe(thinkingOptionId);
      expect(restored.snapshot()).toEqual([
        {
          nativeTurnRef,
          input: [{ type: "text", text: "review auth" }],
          items: [
            {
              item: {
                type: "agentMessage",
                itemId: "assistant-1",
                text: "Checking auth.",
              },
              outcome: { status: "succeeded" },
            },
          ],
          outcome: { status: "succeeded" },
          model,
        },
      ]);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it("falls back to known Native Turn placeholders when no sidecar exists", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-history-"));
    try {
      const history = await AntigravityHistory.open({
        environment: {
          CODEXHOST_DATA_DIR: dataDirectory,
          CODEXHOST_THREAD_ID: "thread-2",
        },
        nativeSessionId: "conversation-1",
        knownTurnRefs: [nativeTurnRef],
      });

      expect(history.snapshot()).toEqual([
        expect.objectContaining({
          nativeTurnRef,
          input: [],
          items: [],
          outcome: expect.objectContaining({ status: "unknown" }),
        }),
      ]);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

it("round-trips child configuration through the strict Antigravity sidecar schema", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-child-config-"));
  const environment = { CODEXHOST_DATA_DIR: directory, CODEXHOST_THREAD_ID: "parent" };
  try {
    const history = await AntigravityHistory.open({
      environment,
      nativeSessionId: "conversation-1",
    });
    history.append({
      nativeTurnRef,
      turnInput: [],
      items: [
        {
          item: {
            type: "subagentDelegation",
            itemId: hostItemIdSchema.parse("delegation"),
            operation: "spawn",
            prompt: "Review",
            subagents: [
              {
                subagentId: "child",
                nativeSubagentId: "child",
                description: "Reviewer",
                role: "reviewer",
                model: "native-model",
                reasoningEffort: "low",
                background: true,
                status: "completed",
              },
            ],
          },
          outcome: { status: "succeeded" },
        },
      ],
      outcome: { status: "succeeded" },
    });
    await history.flush();
    const restored = await AntigravityHistory.open({
      environment,
      nativeSessionId: "conversation-1",
    });
    expect(restored.snapshot()).toEqual(history.snapshot());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
