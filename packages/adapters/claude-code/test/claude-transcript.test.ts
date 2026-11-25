import { createReadStream } from "node:fs";
import type * as NodeFs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mapClaudeSnapshot } from "../src/claude-history.js";
import { readClaudeTranscript } from "../src/claude-transcript.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];

afterEach(async () => {
  vi.mocked(createReadStream).mockReset();
  vi.mocked(readFile).mockClear();
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

async function transcriptFixture(contents: string) {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
  directories.push(configDirectory);
  const cwd = "/work/project";
  const transcriptDirectory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
  await mkdir(transcriptDirectory, { recursive: true });
  const file = path.join(transcriptDirectory, "session-1.jsonl");
  await writeFile(file, contents, "utf8");
  return {
    file,
    input: { cwd, environment: { CLAUDE_CONFIG_DIR: configDirectory }, sessionId: "session-1" },
  };
}

describe("Claude transcript reader", () => {
  it("streams long records without reading the whole transcript into a string", async () => {
    const first = message("user", "user-1", "a".repeat(128 * 1024));
    const reply = message("assistant", "assistant-1", "response");
    const latest = { ...first, slug: "rewritten" };
    const { input } = await transcriptFixture(
      [first, reply, latest].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    vi.mocked(readFile).mockClear();

    expect(await readClaudeTranscript(input)).toEqual(
      [latest, reply].map((entry) => ({ ...entry, session_id: "session-1" })),
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(vi.mocked(createReadStream).mock.results[0]?.value.destroyed).toBe(true);
  });

  it.each([1, 7])(
    "preserves JSONL boundaries and UTF-8 with %s-byte chunks",
    async (highWaterMark) => {
      const first = message("user", "user-1", "中文😀\u2028line\u2029paragraph");
      const attachment = {
        type: "attachment",
        uuid: "attachment-1",
        attachment: { type: "queued_command", prompt: "continue" },
      };
      const reply = message("assistant", "assistant-1", "done");
      const { input } = await transcriptFixture(
        [
          "",
          " \t",
          JSON.stringify(first),
          "not-json",
          "null",
          "[]",
          JSON.stringify({ type: "system", uuid: "system-1" }),
          JSON.stringify({ type: "user", uuid: "missing-message" }),
          JSON.stringify({ ...reply, uuid: 1 }),
          `not-json\r${JSON.stringify(message("user", "bare-cr", "not a separate record"))}`,
          JSON.stringify(attachment),
          JSON.stringify(reply),
        ].join("\r\n"),
      );
      const actual = await vi.importActual<typeof NodeFs>("node:fs");
      vi.mocked(createReadStream).mockImplementationOnce((file, options) =>
        actual.createReadStream(file, {
          ...(typeof options === "string" ? { encoding: options } : options),
          highWaterMark,
        }),
      );

      expect(await readClaudeTranscript(input)).toEqual(
        [first, attachment, reply].map((entry) => ({ ...entry, session_id: "session-1" })),
      );
    },
  );

  it.each([false, true])(
    "rejects stream errors instead of returning partial history (afterRecord=%s)",
    async (afterRecord) => {
      const record = JSON.stringify(message("user", "user-1", "continue"));
      const { input } = await transcriptFixture(record);
      const error = new Error("transcript read failed");
      const stream = Readable.from(
        (async function* () {
          if (afterRecord) yield `${record}\n`;
          throw error;
        })(),
      );
      vi.mocked(createReadStream).mockReturnValueOnce(stream as NodeFs.ReadStream);

      await expect(readClaudeTranscript(input)).rejects.toBe(error);
      expect(stream.destroyed).toBe(true);
    },
  );

  it("distinguishes an empty transcript from a missing file", async () => {
    const { file, input } = await transcriptFixture("");

    expect(await readClaudeTranscript(input)).toEqual([]);
    await rm(file);
    expect(await readClaudeTranscript(input)).toBeNull();
  });

  it("preserves native API failures when restoring a Turn from the transcript", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
    directories.push(configDirectory);
    const cwd = "/work/project";
    const transcriptDirectory = path.join(configDirectory, "projects", projectDirectoryName(cwd));
    await mkdir(transcriptDirectory, { recursive: true });
    const errorText =
      "API Error: 400 historical encrypted reasoning belongs to multiple upstream accounts";
    await writeFile(
      path.join(transcriptDirectory, "session-1.jsonl"),
      [
        message("user", "user-1", "continue"),
        {
          ...message("assistant", "assistant-error", [{ type: "text", text: errorText }]),
          error: "unknown",
          isApiErrorMessage: true,
          apiErrorStatus: 400,
        },
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

    expect(transcript).not.toBeNull();
    expect(transcript && mapClaudeSnapshot(transcript, "session-1").turns).toMatchObject([
      {
        nativeTurnRef: { nativeTurnKey: "user-1" },
        outcome: { status: "failed", error: { code: "nativeFailure" } },
        items: [
          {
            item: { type: "agentMessage", text: errorText },
            outcome: { status: "failed" },
          },
        ],
      },
    ]);
  });

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
