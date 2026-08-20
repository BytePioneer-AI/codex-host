import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { readGrokNativeHistory } from "../src/acp-transport.js";
import { mapGrokReplay } from "../src/grok-history.js";

const grokHarnessId = harnessIdSchema.parse("grok");

async function withTempDir<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Grok ACP auto-compact without a real compact", () => {
  it("maps persisted _x.ai/session/update compact records from Native history", async () => {
    await withTempDir("codexhost-grok-compact-history-", async (grokHome) => {
      const cwd = "/workspace";
      const sessionId = "01a013ca-b13e-7742-8495-ab64229d629a";
      const sessionDir = path.join(
        grokHome,
        "sessions",
        encodeURIComponent(path.resolve(cwd)),
        sessionId,
      );
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, "updates.jsonl"),
        [
          {
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "continue" },
                messageId: "user-1",
              },
              _meta: { eventId: "user-1" },
            },
          },
          {
            method: "_x.ai/session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "auto_compact_started",
                tokens_used: 401965,
                context_window: 500000,
                percentage: 80,
                reason: "Context window 80% full",
              },
            },
          },
          {
            method: "_x.ai/session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "compaction_checkpoint",
                checkpoint_id: "d5d126ae-882f-46f2-aec1-7a2383d14a41",
              },
            },
          },
          {
            method: "_x.ai/session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "auto_compact_completed",
                tokens_before: 401965,
                tokens_after: 10820,
                elapsed_ms: 51274,
                summary_preview: null,
              },
            },
          },
          {
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "after compact" },
              },
              _meta: { totalTokens: 10820 },
            },
          },
          {
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                stop_reason: "end_turn",
              },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );

      const events = await readGrokNativeHistory(
        { cwd, environment: { GROK_HOME: grokHome } },
        sessionId,
      );
      expect(events.map(({ type }) => type)).toEqual([
        "user.text",
        "compaction.started",
        "compaction.completed",
        "agent.text",
        "turn.completed",
      ]);
      expect(events).toContainEqual({
        type: "compaction.started",
        tokensUsed: 401965,
        contextWindowTokens: 500000,
      });
      expect(events).toContainEqual({
        type: "compaction.completed",
        outcome: "succeeded",
        tokensBefore: 401965,
        tokensAfter: 10820,
      });

      const snapshot = mapGrokReplay(events, grokHarnessId, sessionId, cwd);
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.items).toMatchObject([
        { item: { type: "contextCompaction" }, outcome: { status: "succeeded" } },
        { item: { type: "agentMessage", text: "after compact" }, outcome: { status: "succeeded" } },
      ]);
    });
  });
});
