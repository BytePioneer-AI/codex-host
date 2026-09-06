import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mapClaudeSnapshot } from "../src/claude-history.js";
import { readClaudeSubagentTranscript, readClaudeTranscript } from "../src/claude-transcript.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

function message(type: "user" | "assistant", uuid: string, content: unknown) {
  return {
    type,
    uuid,
    sessionId: "session-1",
    message: { role: type, content },
  };
}

describe("Claude transcript reader", () => {
  it("reads all main-session messages in append order instead of following one parent branch", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
    directories.push(configDirectory);
    const cwd = "/work/project";
    const transcriptDirectory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(
      path.join(transcriptDirectory, "session-1.jsonl"),
      [
        message("user", "user-1", "first prompt"),
        message("assistant", "assistant-1", [{ type: "text", text: "first response" }]),
        {
          type: "system",
          uuid: "system-1",
          parentUuid: "user-1",
        },
        message("user", "user-2", "second prompt"),
        message("assistant", "assistant-2", [{ type: "text", text: "second response" }]),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    const transcript = await readClaudeTranscript({
      cwd,
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      sessionId: "session-1",
    });

    expect(transcript).toEqual([
      {
        ...message("user", "user-1", "first prompt"),
        session_id: "session-1",
      },
      {
        ...message("assistant", "assistant-1", [{ type: "text", text: "first response" }]),
        session_id: "session-1",
      },
      {
        ...message("user", "user-2", "second prompt"),
        session_id: "session-1",
      },
      {
        ...message("assistant", "assistant-2", [{ type: "text", text: "second response" }]),
        session_id: "session-1",
      },
    ]);
    expect(transcript && mapClaudeSnapshot(transcript, "session-1").turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        input: [{ type: "text", text: "first prompt" }],
        items: [{ item: { type: "agentMessage", text: "first response" } }],
      },
      {
        nativeTurnRef: { nativeTurnKey: "user-2" },
        input: [{ type: "text", text: "second prompt" }],
        items: [{ item: { type: "agentMessage", text: "second response" } }],
      },
    ]);
  });
});

describe("Claude subagent transcript reader", () => {
  it("reads every subagent record in file order with interleaved attachments", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-sub-"));
    directories.push(configDirectory);
    const cwd = "/work/project";
    const sessionId = "session-1";
    const nativeSubagentId = "native-agent-1";
    const subagentDirectory = path.join(
      configDirectory,
      "projects",
      projectDirectoryName(cwd),
      sessionId,
      "subagents",
    );
    await mkdir(subagentDirectory, { recursive: true });
    await writeFile(
      path.join(subagentDirectory, `agent-${nativeSubagentId}.jsonl`),
      [
        message("user", "sub-user-1", "inspect the directory"),
        { type: "attachment", uuid: "attachment-1", parentUuid: "sub-user-1" },
        message("assistant", "sub-assistant-1", [{ type: "text", text: "listing files" }]),
        message("user", "sub-tool-result", [
          { type: "tool_result", tool_use_id: "bash-1", content: "a.txt\nb.txt" },
        ]),
        message("assistant", "sub-assistant-2", [{ type: "text", text: "found two files" }]),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );

    const transcript = await readClaudeSubagentTranscript({
      cwd,
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      sessionId,
      nativeSubagentId,
    });

    expect(transcript).toEqual([
      { ...message("user", "sub-user-1", "inspect the directory"), session_id: sessionId },
      {
        ...message("assistant", "sub-assistant-1", [{ type: "text", text: "listing files" }]),
        session_id: sessionId,
      },
      {
        ...message("user", "sub-tool-result", [
          { type: "tool_result", tool_use_id: "bash-1", content: "a.txt\nb.txt" },
        ]),
        session_id: sessionId,
      },
      {
        ...message("assistant", "sub-assistant-2", [{ type: "text", text: "found two files" }]),
        session_id: sessionId,
      },
    ]);
  });

  it("falls back to scanning sibling project directories and returns null when absent", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-sub-"));
    directories.push(configDirectory);
    const sessionId = "session-2";
    const nativeSubagentId = "native-agent-2";
    // The file lives under a project directory name that does not match cwd.
    const subagentDirectory = path.join(
      configDirectory,
      "projects",
      "some-other-project",
      sessionId,
      "subagents",
    );
    await mkdir(subagentDirectory, { recursive: true });
    await writeFile(
      path.join(subagentDirectory, `agent-${nativeSubagentId}.jsonl`),
      JSON.stringify(message("assistant", "sub-assistant-only", [{ type: "text", text: "hi" }])),
      "utf8",
    );

    const found = await readClaudeSubagentTranscript({
      cwd: "/work/unmatched",
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      sessionId,
      nativeSubagentId,
    });
    expect(found).toEqual([
      {
        ...message("assistant", "sub-assistant-only", [{ type: "text", text: "hi" }]),
        session_id: sessionId,
      },
    ]);

    await expect(
      readClaudeSubagentTranscript({
        cwd: "/work/unmatched",
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        sessionId,
        nativeSubagentId: "missing-agent",
      }),
    ).resolves.toBeNull();
  });
});
