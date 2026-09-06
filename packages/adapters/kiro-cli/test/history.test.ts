import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { projectHistoricalTurn } from "../../../protocol-core/src/codex-ui-projector.js";

import {
  findForkBoundary,
  findRollbackBoundary,
  locateKiroNativeSession,
  parseKiroHistory,
  readKiroSnapshot,
  readKiroNativeMessages,
  type KiroHistoryRow,
} from "../src/history.js";

describe("kiro native history", () => {
  it("preserves native turn outcomes, tool results and message order across repeated reads", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-native-history-"));
    try {
      const rows: KiroHistoryRow[] = [
        { id: "u1", payload: { type: "user", content: "first input" } },
        { id: "s1", timestamp: "2026-09-06T09:00:00.000Z", payload: { type: "turn_start" } },
        { id: "a1", payload: { type: "assistant", content: "before tool" } },
        {
          id: "t1",
          payload: {
            type: "tool_call",
            toolCallId: "call1",
            toolName: "read_file",
            args: { path: "a.txt" },
          },
        },
        {
          id: "r1",
          payload: {
            type: "tool_result",
            toolCallId: "call1",
            content: "native result",
            success: true,
          },
        },
        { id: "a2", payload: { type: "assistant", content: "after tool" } },
        {
          id: "e1",
          timestamp: "2026-09-06T09:01:43.000Z",
          payload: { type: "turn_end", stopReason: "end_turn" },
        },
        { id: "init", payload: { type: "tool_call", toolName: "fetch_cloud_config" } },
        { id: "u2", payload: { type: "user", content: "second input" } },
        {
          id: "t2",
          payload: { type: "tool_call", toolCallId: "call2", toolName: "edit", args: {} },
        },
        {
          id: "r2",
          payload: { type: "tool_result", toolCallId: "call2", content: "denied", success: false },
        },
        { id: "e2", payload: { type: "turn_end", stopReason: "cancelled" } },
        { id: "u3", payload: { type: "user", content: "incomplete input" } },
      ];
      await fs.writeFile(
        path.join(directory, "messages.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n"),
        "utf8",
      );
      const location = {
        sessionDirectory: directory,
        sessionMeta: { id: "native", workspacePaths: [directory] },
        cwd: directory,
      };
      const snapshot = await readKiroSnapshot(location);
      expect(snapshot.turns.map((t) => t.outcome.status)).toEqual([
        "succeeded",
        "cancelled",
        "unknown",
      ]);
      expect(snapshot.turns.map((t) => t.input[0]?.text)).toEqual([
        "first input",
        "second input",
        "incomplete input",
      ]);
      expect(snapshot.turns[0]?.items.map((i) => i.item.type)).toEqual([
        "agentMessage",
        "toolExecution",
        "agentMessage",
      ]);
      expect(snapshot.turns[0]?.items[1]?.item).toMatchObject({
        toolName: "read_file",
        arguments: { path: "a.txt" },
        output: { content: [{ type: "text", text: "native result" }] },
      });
      expect(snapshot.turns[1]?.items[0]?.outcome.status).toBe("failed");
      const firstTurn = snapshot.turns[0];
      if (!firstTurn) throw new Error("Missing first turn");
      expect(firstTurn.items[0]?.item).toMatchObject({ phase: "commentary" });
      expect(firstTurn.items[2]?.item).toMatchObject({ phase: "final_answer" });
      expect(
        projectHistoricalTurn({
          turnId: hostTurnIdSchema.parse("restored"),
          cwd: directory,
          snapshot: firstTurn,
        }),
      ).toMatchObject({
        startedAt: Date.parse("2026-09-06T09:00:00.000Z") / 1000,
        completedAt: Date.parse("2026-09-06T09:01:43.000Z") / 1000,
        durationMs: 103_000,
        items: [
          { type: "userMessage" },
          { type: "agentMessage", text: "before tool", phase: "commentary" },
          { type: "commandExecution" },
          { type: "agentMessage", text: "after tool", phase: "final_answer" },
        ],
      });
      expect(await readKiroSnapshot(location)).toEqual(snapshot);
      await fs.writeFile(path.join(directory, "messages.jsonl"), "{broken", "utf8");
      await expect(readKiroSnapshot(location)).rejects.toThrow();
      await expect(readKiroNativeMessages(path.join(directory, "missing"))).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  describe("parseKiroHistory and boundaries", () => {
    const sampleRows: KiroHistoryRow[] = [
      {
        id: "msg-bootstrap",
        payload: { type: "system", text: "Session initialized" },
      },
      {
        id: "msg-user-1",
        payload: { type: "user", text: "Hello Kiro" },
      },
      {
        id: "msg-asst-1",
        payload: { type: "assistant", text: "Hello! How can I help?" },
      },
      {
        id: "msg-end-1",
        payload: { type: "turn_end" },
      },
      {
        id: "msg-user-2",
        payload: { type: "user", text: "Create a file" },
      },
      {
        id: "msg-tool-1",
        payload: {
          type: "tool_call",
          name: "write_file",
          rawInput: { path: "test.txt", content: "hello" },
        },
      },
      {
        id: "msg-end-2",
        payload: { type: "turn_end" },
      },
    ];

    it("parses rows into turns and identifies bootstrap message", () => {
      const summary = parseKiroHistory(sampleRows);
      expect(summary.bootstrapMessageId).toBe("msg-bootstrap");
      expect(summary.turns).toHaveLength(2);

      expect(summary.turns[0]?.userMessageId).toBe("msg-user-1");
      expect(summary.turns[0]?.userPromptText).toBe("Hello Kiro");
      expect(summary.turns[0]?.turnEndMessageId).toBe("msg-end-1");

      expect(summary.turns[1]?.userMessageId).toBe("msg-user-2");
      expect(summary.turns[1]?.userPromptText).toBe("Create a file");
      expect(summary.turns[1]?.turnEndMessageId).toBe("msg-end-2");
    });

    it("finds fork boundary for specific checkpoint and last turn", () => {
      const summary = parseKiroHistory(sampleRows);

      // Explicit target
      expect(findForkBoundary(summary, "msg-end-1")).toBe("msg-end-1");
      expect(findForkBoundary(summary, "msg-user-1")).toBe("msg-end-1");
      expect(findForkBoundary(summary, "msg-tool-1")).toBe("msg-tool-1");

      // Default to last turn
      expect(findForkBoundary(summary)).toBe("msg-end-2");

      // Nonexistent target
      expect(findForkBoundary(summary, "nonexistent")).toBeNull();
    });

    it("resolves rollback boundary correctly for multi-turn session", () => {
      const summary = parseKiroHistory(sampleRows);
      // For 2 turns, rolling back the last turn yields turn 0's end
      const boundary = findRollbackBoundary(summary);
      expect(boundary).toBe("msg-end-1");
    });

    it("resolves rollback boundary to bootstrap message for 1-turn session", () => {
      const singleTurnSummary = parseKiroHistory(sampleRows.slice(0, 4));
      expect(singleTurnSummary.turns).toHaveLength(1);
      const boundary = findRollbackBoundary(singleTurnSummary);
      expect(boundary).toBe("msg-bootstrap");
    });

    it("returns null rollback boundary when no turns or no bootstrap exists", () => {
      expect(findRollbackBoundary({ turns: [] })).toBeNull();
      expect(
        findRollbackBoundary({
          turns: [{ turnIndex: 0, userMessageId: "u1", userPromptText: "", rows: [] }],
        }),
      ).toBeNull();
    });
  });

  describe("locateKiroNativeSession and readKiroSnapshot", () => {
    it("locates session and parses snapshot from filesystem", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-history-test-"));
      const sessionsRoot = path.join(tmpDir, "sessions");
      const bucketDir = path.join(sessionsRoot, "bucket-abc");
      const sessionDir = path.join(bucketDir, "sess-123");
      const workspaceDir = path.join(tmpDir, "workspace");

      await fs.mkdir(sessionDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });

      const sessionMeta = {
        id: "sess-123",
        workspacePaths: [workspaceDir],
        modelId: "claude-sonnet-4.5",
        autopilot: "on",
      };
      await fs.writeFile(
        path.join(sessionDir, "session.json"),
        JSON.stringify(sessionMeta),
        "utf8",
      );

      const messages = [
        JSON.stringify({
          id: "m-user-1",
          payload: { type: "user", content: "Hello" },
        }),
        JSON.stringify({
          id: "m-asst-1",
          payload: { type: "assistant", content: "Greetings!" },
        }),
        JSON.stringify({
          id: "m-tool-1",
          payload: {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "diff_tool",
            args: { path: "file.txt" },
          },
        }),
        JSON.stringify({
          id: "m-result-1",
          payload: {
            type: "tool_result",
            toolCallId: "call-1",
            success: true,
            content: [
              {
                type: "diff",
                path: path.join(workspaceDir, "file.txt"),
                oldText: "a\n",
                newText: "b\n",
              },
            ],
          },
        }),
        JSON.stringify({
          id: "m-end-1",
          payload: { type: "turn_end", stopReason: "end_turn" },
        }),
      ].join("\n");

      await fs.writeFile(path.join(sessionDir, "messages.jsonl"), messages, "utf8");

      // Test locate
      const location = await locateKiroNativeSession(
        { environment: { KIRO_HOME: tmpDir } },
        "sess-123",
      );

      expect(location).not.toBeNull();
      expect(location?.sessionDirectory).toBe(sessionDir);
      expect(location?.cwd).toBe(path.resolve(workspaceDir));
      expect(location?.sessionMeta.modelId).toBe("claude-sonnet-4.5");

      // Test snapshot reading
      if (location) {
        const snapshot = await readKiroSnapshot(location);
        expect(snapshot.turns).toHaveLength(1);
        expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "Hello" }]);
        expect(snapshot.turns[0]?.items).toHaveLength(3); // agentMessage, toolExecution, fileChange

        const agentMsg = snapshot.turns[0]?.items.find((i) => i.item.type === "agentMessage");
        expect(agentMsg).toBeDefined();

        const toolExec = snapshot.turns[0]?.items.find((i) => i.item.type === "toolExecution");
        expect(toolExec).toBeDefined();
        expect(toolExec?.item).toMatchObject({
          toolName: "diff_tool",
          arguments: { path: "file.txt" },
        });
        expect(snapshot.turns[0]?.outcome.status).toBe("succeeded");

        const fileChange = snapshot.turns[0]?.items.find((i) => i.item.type === "fileChange");
        expect(fileChange).toBeDefined();

        expect(snapshot.state?.effectiveModel?.id).toBe("claude-sonnet-4.5");
        expect(snapshot.state?.effectivePermissionModeId).toBe("autopilot");
      }

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
