import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  it.each([false, true])(
    "normalizes repeated UUIDs before projection, retaining their order and latest record (updated=%s)",
    async (updated) => {
      const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
      directories.push(configDirectory);
      const cwd = "/work/project";
      const transcriptDirectory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
      await mkdir(transcriptDirectory, { recursive: true });
      const file = path.join(transcriptDirectory, "session-1.jsonl");
      const firstUser = {
        ...message("user", "user-1", "first prompt"),
        slug: "original",
        promptId: "prompt-1",
      };
      const firstAssistant = message("assistant", "assistant-1", "first response");
      const latestUser = updated
        ? { ...message("user", "user-1", "first prompt"), slug: "rewritten" }
        : firstUser;
      const latestAssistant = updated
        ? message("assistant", "assistant-1", "updated response")
        : firstAssistant;
      const secondTurn = [
        message("user", "user-2", "second prompt"),
        message("assistant", "assistant-2", "second response"),
      ];
      // Re-appended records may follow newer messages and need not repeat in original order.
      const contents = [firstUser, firstAssistant, ...secondTurn, latestAssistant, latestUser]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      await writeFile(file, contents, "utf8");
      const input = {
        cwd,
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        sessionId: "session-1",
      };

      const transcript = await readClaudeTranscript(input);

      expect(transcript).toEqual(
        [latestUser, latestAssistant, ...secondTurn].map((entry) => ({
          ...entry,
          session_id: "session-1",
        })),
      );
      expect(transcript && mapClaudeSnapshot(transcript, "session-1").turns).toMatchObject([
        {
          nativeTurnRef: { nativeTurnKey: "user-1" },
          input: [{ type: "text", text: "first prompt" }],
          items: [
            {
              item: { type: "agentMessage", text: updated ? "updated response" : "first response" },
            },
          ],
        },
        {
          nativeTurnRef: { nativeTurnKey: "user-2" },
          input: [{ type: "text", text: "second prompt" }],
          items: [{ item: { type: "agentMessage", text: "second response" } }],
        },
      ]);
      expect(await readClaudeTranscript(input)).toEqual(transcript);
      expect(await readFile(file, "utf8")).toBe(contents);
    },
  );

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
