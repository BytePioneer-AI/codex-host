import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mapClaudeSnapshot } from "../src/claude-history.js";
import { readClaudeTranscript } from "../src/claude-transcript.js";

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
