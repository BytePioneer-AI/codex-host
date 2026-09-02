import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  harnessIdSchema,
  nativeTurnRefSchema,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { mapQwenCodeHistory, readQwenCodeHistory } from "../src/qwen-history.js";

const harnessId = harnessIdSchema.parse("qwen-code");
const sessionId = "550e8400-e29b-41d4-a716-446655440000";

function turnRef(key: string): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    harnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: key,
    formatVersion: 1,
  });
}

function projectDirectory(cwd: string): string {
  return (process.platform === "win32" ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

describe("Qwen Code history", () => {
  it("preserves Qwen thought markers and failed Tool results in transcript order", () => {
    const snapshot = mapQwenCodeHistory(
      [
        { type: "user", message: { role: "user", parts: [{ text: "run it" }] } },
        {
          type: "assistant",
          message: {
            role: "model",
            parts: [
              { text: "inspect first", thought: "True" },
              { text: "Running the command." },
              {
                functionCall: {
                  id: "call-1",
                  name: "run_shell_command",
                  args: { command: "exit 1" },
                },
              },
            ],
          },
        },
        {
          type: "tool_result",
          message: {
            role: "user",
            parts: [{ functionResponse: { id: "call-1", response: "boom" } }],
          },
          toolCallResult: {
            callId: "call-1",
            status: "error",
            executionStatus: "error",
            error: {},
            resultDisplay: "boom",
          },
        },
        {
          type: "assistant",
          message: { role: "model", parts: [{ text: "The command failed." }] },
        },
      ],
      harnessId,
      sessionId,
      "/workspace",
    );

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: { type: "reasoning", text: "inspect first" },
        outcome: { status: "succeeded" },
      },
      {
        item: { type: "agentMessage", text: "Running the command." },
        outcome: { status: "succeeded" },
      },
      {
        item: { type: "commandExecution", command: "exit 1", output: "boom" },
        outcome: { status: "failed", error: { code: "nativeFailure" } },
      },
      {
        item: { type: "agentMessage", text: "The command failed." },
        outcome: { status: "succeeded" },
      },
    ]);
  });

  it("restores cancelled Tool results as cancelled items", () => {
    const snapshot = mapQwenCodeHistory(
      [
        { type: "user", message: { role: "user", parts: [{ text: "read it" }] } },
        {
          type: "assistant",
          message: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call-2",
                  name: "read_file",
                  args: { file_path: "/workspace/file.txt" },
                },
              },
            ],
          },
        },
        {
          type: "tool_result",
          toolCallResult: {
            callId: "call-2",
            status: "cancelled",
            executionStatus: "not_started",
            resultDisplay: "Cancelled",
          },
        },
      ],
      harnessId,
      sessionId,
      "/workspace",
    );

    expect(snapshot.turns[0]?.items).toMatchObject([
      {
        item: { type: "toolExecution", toolName: "read_file" },
        outcome: { status: "cancelled" },
      },
    ]);
  });

  it("aligns a truncated transcript with the newest known Native Turn refs", () => {
    const knownTurnRefs = [turnRef("mapped-0"), turnRef("mapped-1"), turnRef("mapped-2")];
    const snapshot = mapQwenCodeHistory(
      [
        { type: "user", message: { role: "user", parts: [{ text: "first" }] } },
        { type: "assistant", message: { role: "model", parts: [{ text: "one" }] } },
        { type: "user", message: { role: "user", parts: [{ text: "second" }] } },
        { type: "assistant", message: { role: "model", parts: [{ text: "two" }] } },
      ],
      harnessId,
      sessionId,
      "/workspace",
      knownTurnRefs,
    );

    expect(snapshot.turns.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "mapped-1",
      "mapped-2",
    ]);
  });

  it("reconstructs persisted Qwen turns and preserves known native identities", () => {
    const snapshot = mapQwenCodeHistory(
      [
        { type: "user", message: { role: "user", content: "status" } },
        { type: "assistant", message: { role: "model", parts: [{ text: "clean" }] } },
        { type: "user", message: { role: "user", content: "again" } },
        { type: "assistant", message: { role: "model", parts: [{ text: "done" }] } },
      ],
      harnessIdSchema.parse("qwen-code"),
      "550e8400-e29b-41d4-a716-446655440000",
      "/tmp",
      [
        {
          harnessId: harnessIdSchema.parse("qwen-code"),
          nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
          nativeTurnKey: "qwen-turn-0",
          formatVersion: 1,
        },
        {
          harnessId: harnessIdSchema.parse("qwen-code"),
          nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
          nativeTurnKey: "qwen-turn-1",
          formatVersion: 1,
        },
      ],
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns.map((turn) => turn.input)).toEqual([
      [{ type: "text", text: "status" }],
      [{ type: "text", text: "again" }],
    ]);
    expect(snapshot.turns[1]?.nativeTurnRef.nativeTurnKey).toBe("qwen-turn-1");
    expect(snapshot.turns[1]?.items[0]?.item).toMatchObject({ type: "agentMessage", text: "done" });
  });
  it("reads history from the Session QWEN_RUNTIME_DIR relative to cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-qwen-history-"));
    const cwd = path.join(root, "workspace");
    try {
      const chats = path.join(cwd, ".qwen-runtime", "projects", projectDirectory(cwd), "chats");
      await mkdir(chats, { recursive: true });
      await writeFile(
        path.join(chats, `${sessionId}.jsonl`),
        [
          { type: "user", message: { role: "user", parts: [{ text: "hello" }] } },
          { type: "assistant", message: { role: "model", parts: [{ text: "world" }] } },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
        "utf8",
      );

      const snapshot = await readQwenCodeHistory(cwd, harnessId, sessionId, [], 64_000, {
        QWEN_RUNTIME_DIR: ".qwen-runtime",
      });

      expect(snapshot.turns[0]).toMatchObject({
        input: [{ type: "text", text: "hello" }],
        items: [{ item: { type: "agentMessage", text: "world" } }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
