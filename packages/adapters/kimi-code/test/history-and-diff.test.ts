import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HostAgentMessageItem } from "@codexhost/harness-adapter";

import {
  createKimiNativeSessionRef,
  createKimiNativeTurnRef,
  extractKimiUsageFromWireLog,
  locateKimiSession,
  parseKimiWireLog,
  readKimiSessionSnapshot,
  readKimiSessionUsage,
} from "../src/history.js";

describe("Kimi Code History & Diff", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kimi-hist-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe("Native References", () => {
    it("creates valid native session and turn references", () => {
      const sessionRef = createKimiNativeSessionRef("session-abc", "D:/project");
      expect(sessionRef.harnessId).toBe("kimi-code");
      expect(sessionRef.nativeSessionId).toBe("session-abc");
      expect(sessionRef.locator).toEqual({ cwd: "D:/project" });

      const turnRef = createKimiNativeTurnRef("session-abc", 1);
      expect(turnRef.harnessId).toBe("kimi-code");
      expect(turnRef.nativeSessionId).toBe("session-abc");
      expect(turnRef.nativeTurnKey).toBe("turn:1");
    });
  });

  describe("locateKimiSession", () => {
    it("locates existing session from session_index.jsonl and state.json", async () => {
      const sessionId = "session-123";
      const sessionDir = path.join(tempDir, "sessions", "ws-1", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });

      const indexContent =
        JSON.stringify({
          sessionId,
          sessionDir,
          workDir: tempDir,
        }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      const stateContent = JSON.stringify({
        id: sessionId,
        version: 2,
        cwd: tempDir,
        agents: {
          main: {
            homedir: path.join(sessionDir, "agents", "main"),
            type: "main",
          },
        },
      });
      await writeFile(path.join(sessionDir, "state.json"), stateContent, "utf8");

      const located = await locateKimiSession(sessionId, { kimiCodeHome: tempDir });
      expect(located).not.toBeNull();
      expect(located?.state.id).toBe(sessionId);
      expect(located?.sessionDir).toBe(sessionDir);
      expect(located?.mainHomeDir).toBe(path.join(sessionDir, "agents", "main"));
    });

    it("returns null when session is not in index", async () => {
      await writeFile(path.join(tempDir, "session_index.jsonl"), "", "utf8");
      const located = await locateKimiSession("nonexistent", { kimiCodeHome: tempDir });
      expect(located).toBeNull();
    });

    it("returns null when session is marked deleted", async () => {
      const sessionId = "deleted-session";
      const indexContent =
        JSON.stringify({
          sessionId,
          sessionDir: path.join(tempDir, "sessions", sessionId),
          deleted: true,
        }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      const located = await locateKimiSession(sessionId, { kimiCodeHome: tempDir });
      expect(located).toBeNull();
    });

    it("rejects path traversal outside kimi home", async () => {
      const sessionId = "traversal-session";
      const outsideDir = path.resolve(tempDir, "..", "outside-dir");
      const indexContent =
        JSON.stringify({
          sessionId,
          sessionDir: outsideDir,
        }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      await expect(locateKimiSession(sessionId, { kimiCodeHome: tempDir })).rejects.toThrow(
        /outside KIMI_CODE_HOME/,
      );
    });
  });

  describe("parseKimiWireLog", () => {
    it("parses completed turn with tool calls, text and file diff", async () => {
      const mainHomeDir = path.join(tempDir, "main");
      await mkdir(path.join(mainHomeDir, "file-history"), { recursive: true });

      const oldPath = path.join(mainHomeDir, "file-history", "old.txt");
      const newPath = path.join(mainHomeDir, "file-history", "new.txt");
      await writeFile(oldPath, "line 1\nline 2\n", "utf8");
      await writeFile(newPath, "line 1\nline 2 modified\nline 3 added\n", "utf8");

      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          promptId: "msg-001",
          time: 1000,
          input: [{ type: "text", text: "Modify file" }],
        }),
        JSON.stringify({
          type: "usage.record",
          agentId: "main",
          turnId: 0,
          model: "relay",
        }),
        JSON.stringify({
          type: "file_history.tracked",
          agentId: "main",
          turnId: 0,
          path: "sample.txt",
          entry: { key: "file-history/old.txt", version: 1 },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "tool.call",
            toolCallId: "tool-1",
            name: "Write",
            args: { path: "sample.txt", content: "..." },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "tool.result",
            toolCallId: "tool-1",
            result: { output: "Updated sample.txt" },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "content.part",
            turnId: 0,
            part: { type: "text", text: "File was updated successfully." },
          },
        }),
        JSON.stringify({
          type: "file_history.checkpoint",
          agentId: "main",
          turnId: 0,
          entries: {
            "sample.txt": { key: "file-history/new.txt", version: 2, size: 45 },
          },
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "completed",
          time: 5000,
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-test", mainHomeDir);
      expect(turns).toHaveLength(1);

      const turn = turns[0];
      expect(turn).toBeDefined();
      if (!turn) return;
      expect(turn.nativeTurnRef.nativeTurnKey).toBe("turn:0");
      expect(turn.outcome.status).toBe("succeeded");
      expect(turn.input).toEqual([{ type: "text", text: "Modify file" }]);
      expect(turn.startedAtMs).toBe(1000);
      expect(turn.completedAtMs).toBe(5000);

      // Check items: reasoning / agentMessage / tool / fileChange
      const agentMsg = turn.items.find((i) => i.item.type === "agentMessage");
      expect(agentMsg).toBeDefined();
      if (agentMsg && agentMsg.item.type === "agentMessage") {
        expect(agentMsg.item.text).toBe("File was updated successfully.");
      }

      const toolItem = turn.items.find((i) => i.item.type === "toolExecution");
      expect(toolItem).toBeDefined();
      if (toolItem && toolItem.item.type === "toolExecution") {
        expect(toolItem.item.toolName).toBe("Write");
      }

      const fileChangeItem = turn.items.find((i) => i.item.type === "fileChange");
      expect(fileChangeItem).toBeDefined();
      if (fileChangeItem && fileChangeItem.item.type === "fileChange") {
        expect(fileChangeItem.item.changes).toHaveLength(1);
        const change = fileChangeItem.item.changes[0];
        expect(change).toBeDefined();
        if (change) {
          expect(change.path).toBe("sample.txt");
          expect(change.kind).toBe("update");
          expect(change.unifiedDiff).toContain("-line 2");
          expect(change.unifiedDiff).toContain("+line 2 modified");
          expect(change.unifiedDiff).toContain("+line 3 added");
        }
      }
    });

    it("parses cancelled turn accurately", async () => {
      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Long task" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "cancelled",
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-cancel");
      expect(turns).toHaveLength(1);
      const turn = turns[0];
      expect(turn).toBeDefined();
      if (!turn) return;
      expect(turn.outcome.status).toBe("cancelled");
      if (turn.outcome.status === "cancelled") {
        expect(turn.outcome.reason).toContain("cancelled");
      }
    });

    it("handles multiple turns in sequence", async () => {
      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Turn 1" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "completed",
        }),
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 1,
          input: [{ type: "text", text: "Turn 2" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 1,
          reason: "completed",
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-seq");
      expect(turns).toHaveLength(2);
      expect(turns[0]?.nativeTurnRef.nativeTurnKey).toBe("turn:0");
      expect(turns[1]?.nativeTurnRef.nativeTurnKey).toBe("turn:1");
    });
  });

  async function createSnapshotSession(sessionId: string): Promise<string> {
    const sessionDir = path.join(tempDir, "sessions", sessionId);
    const mainHomeDir = path.join(sessionDir, "agents", "main");
    await mkdir(mainHomeDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "session_index.jsonl"),
      JSON.stringify({ sessionId, sessionDir }) + "\n",
    );
    await writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
    );
    return mainHomeDir;
  }

  describe("readKimiSessionSnapshot", () => {
    it("reads snapshot using located directory", async () => {
      const sessionId = "session-snap";
      const mainHomeDir = await createSnapshotSession(sessionId);
      await writeFile(
        path.join(mainHomeDir, "wire.jsonl"),
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Hello" }],
        }) +
          "\n" +
          JSON.stringify({
            type: "turn.ended",
            agentId: "main",
            turnId: 0,
            reason: "completed",
          }) +
          "\n",
      );

      const snapshot = await readKimiSessionSnapshot(sessionId, { kimiCodeHome: tempDir });
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.outcome.status).toBe("succeeded");
    });

    it("preserves a present but empty native history", async () => {
      const sessionId = "session-empty";
      const mainHomeDir = await createSnapshotSession(sessionId);
      await writeFile(path.join(mainHomeDir, "wire.jsonl"), "");

      await expect(readKimiSessionSnapshot(sessionId, { kimiCodeHome: tempDir })).resolves.toEqual({
        turns: [],
      });
    });

    it("reports a missing native history instead of returning an empty snapshot", async () => {
      const sessionId = "session-missing-wire";
      await createSnapshotSession(sessionId);

      await expect(readKimiSessionSnapshot(sessionId, { kimiCodeHome: tempDir })).rejects.toThrow(
        /Failed to read Kimi native history.*wire\.jsonl/,
      );
    });
  });

  describe("Usage extraction", () => {
    it("extracts cumulative usage and contextUsedTokens from wire log", () => {
      const wire = [
        JSON.stringify({
          type: "usage.record",
          turnId: 0,
          usage: { inputOther: 100, output: 50, inputCacheRead: 500, inputCacheCreation: 200 },
        }),
        JSON.stringify({
          type: "token_counting.measured",
          tokens: 850,
        }),
        JSON.stringify({
          type: "usage.record",
          turnId: 1,
          usage: { inputOther: 50, output: 80, inputCacheRead: 800, inputCacheCreation: 100 },
        }),
        JSON.stringify({
          type: "token_counting.turn_recorded",
          turnId: 1,
          tokens: 1030,
        }),
      ].join("\n");

      const usage = extractKimiUsageFromWireLog(wire, 200_000);
      expect(usage).toEqual({
        inputTokens: 150,
        outputTokens: 130,
        cachedInputTokens: 1300,
        cacheWriteInputTokens: 300,
        totalTokens: 1880,
        contextUsedTokens: 1030,
        contextWindowTokens: 200_000,
        contextUsagePercent: (1030 / 200_000) * 100,
        cacheHitRatePercent: (1300 / 1750) * 100,
      });
    });

    it("returns null when wire log contains no usage records", () => {
      expect(extractKimiUsageFromWireLog("", 200_000)).toBeNull();
      expect(extractKimiUsageFromWireLog('{"type":"metadata"}', 200_000)).toBeNull();
    });

    it("reads usage for a located session via readKimiSessionUsage", async () => {
      const sessionId = "session-usage-test";
      const mainHomeDir = await createSnapshotSession(sessionId);
      await writeFile(
        path.join(mainHomeDir, "wire.jsonl"),
        JSON.stringify({
          type: "usage.record",
          usage: { inputOther: 200, output: 100, inputCacheRead: 1000, inputCacheCreation: 0 },
        }) +
          "\n" +
          JSON.stringify({
            type: "token_counting.measured",
            tokens: 1300,
          }) +
          "\n",
      );

      const usage = await readKimiSessionUsage(sessionId, {
        kimiCodeHome: tempDir,
        contextWindowTokens: 200_000,
      });
      expect(usage).toBeDefined();
      expect(usage?.inputTokens).toBe(200);
      expect(usage?.outputTokens).toBe(100);
      expect(usage?.contextUsedTokens).toBe(1300);
      expect(usage?.contextWindowTokens).toBe(200_000);
    });

    it("routes thoughts to reasoning, commentary to commentary message, and terminal text to final answer", async () => {
      const wire = [
        JSON.stringify({
          type: "turn.prompt",
          turnId: 0,
          time: 1000,
          input: [{ type: "text", text: "write code\n" }],
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            turnId: 0,
            part: { type: "thought", text: "Planning quicksort implementation..." },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            turnId: 0,
            part: { type: "text", text: "I will write quicksort.py now." },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "tool.call",
            turnId: 0,
            toolCallId: "call-1",
            name: "Write",
            args: { path: "quicksort.py" },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "tool.result", turnId: 0, toolCallId: "call-1", result: { output: "ok" } },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            turnId: 0,
            part: { type: "text", text: "Successfully created quicksort.py." },
          },
        }),
        JSON.stringify({
          type: "turn.ended",
          turnId: 0,
          reason: "completed",
          time: 15000,
          durationMs: 14000,
        }),
      ].join("\n");

      const snapshots = await parseKimiWireLog(wire, "s-fold-1");
      expect(snapshots).toHaveLength(1);
      const turn = snapshots[0];
      expect(turn).toBeDefined();
      if (!turn) return;

      // Reasoning should have ONLY the thought text
      const reasoning = turn.items.find((i) => i.item.type === "reasoning");
      expect(reasoning).toBeDefined();
      if (reasoning && reasoning.item.type === "reasoning") {
        expect(reasoning.item.text).toBe("Planning quicksort implementation...");
      }

      // Commentary message should have the pre-tool text with phase: commentary
      const commentaryMsg = turn.items.find(
        (i) =>
          i.item.type === "agentMessage" && (i.item as HostAgentMessageItem).phase === "commentary",
      );
      expect(commentaryMsg).toBeDefined();
      if (commentaryMsg && commentaryMsg.item.type === "agentMessage") {
        expect(commentaryMsg.item.text).toBe("I will write quicksort.py now.");
      }

      // Final agent message should have the post-tool text with phase: final_answer
      const finalMsg = turn.items.find(
        (i) =>
          i.item.type === "agentMessage" &&
          (i.item as HostAgentMessageItem).phase === "final_answer",
      );
      expect(finalMsg).toBeDefined();
      if (finalMsg && finalMsg.item.type === "agentMessage") {
        expect(finalMsg.item.text).toBe("Successfully created quicksort.py.");
      }

      // Timing must be properly populated
      expect(turn.startedAtMs).toBe(1000);
      expect(turn.completedAtMs).toBe(15000);
    });

    it("populates fallback completedAtMs when the terminal record has no timestamp", async () => {
      const wire = [
        JSON.stringify({
          type: "turn.prompt",
          turnId: 0,
          time: 2000,
          input: [{ type: "text", text: "cancelled task" }],
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: { type: "content.part", turnId: 0, part: { type: "text", text: "Working..." } },
          turnId: 0,
          time: 5500,
        }),
        JSON.stringify({ type: "agent.turn.ended", turnId: 0, outcome: "cancelled" }),
      ].join("\n");

      const snapshots = await parseKimiWireLog(wire, "s-cancel-time");
      expect(snapshots).toHaveLength(1);
      const turn = snapshots[0];
      expect(turn).toBeDefined();
      if (!turn) return;
      expect(turn.startedAtMs).toBe(2000);
      expect(turn.completedAtMs).toBe(5500);
      expect(turn.outcome.status).toBe("cancelled");
    });
  });
});
