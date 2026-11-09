import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mapOmpSnapshot } from "../src/omp-history.js";
import { verifyOmpSessionCwd, readOmpSessionHistory } from "../src/omp-session-file.js";
import { ompUsageHistory } from "../src/omp-usage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("OMP session files", () => {
  it("finds the session header after OMP's title record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "title", title: "" })}\n${JSON.stringify({
        type: "session",
        id: "omp-session",
        cwd: directory,
      })}\n`,
    );

    await expect(
      verifyOmpSessionCwd({
        sessionFile,
        sessionId: "omp-session",
        expectedCwd: directory,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { name: "LF", newline: "\n", finalNewline: true, padding: 0 },
    { name: "CRLF", newline: "\r\n", finalNewline: true, padding: 0 },
    { name: "no final newline", newline: "\n", finalNewline: false, padding: 0 },
    { name: "multiple UTF-8 stream chunks", newline: "\n", finalNewline: true, padding: 40_000 },
  ])("preserves Unicode line separators with $name", async ({ newline, finalNewline, padding }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const output = `before\u2028middle\u2029after${"中😀".repeat(padding)}`;
    const entries = [
      { type: "title", title: "synthetic history" },
      { type: "session", id: "omp-session", cwd: directory },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "read output" }] },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "user-1",
        message: { role: "toolResult", content: [{ type: "text", text: output }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "tool-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
    ];
    await writeFile(
      sessionFile,
      newline +
        entries.map((entry) => JSON.stringify(entry)).join(newline) +
        (finalNewline ? newline : ""),
    );

    const history = await readOmpSessionHistory(sessionFile);
    expect(history.incomplete).toBeUndefined();
    expect(history.entries).toHaveLength(3);
    expect(history.leafId).toBe("assistant-1");
    expect(history.entries[1]).toMatchObject({
      id: "tool-1",
      message: { content: [{ type: "text", text: output }] },
    });
    const snapshot = mapOmpSnapshot(history, { sessionId: "omp-session", model: null });
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user-1" },
      input: [{ type: "text", text: "read output" }],
      outcome: { status: "succeeded" },
    });
  });

  it("reads an empty history without inventing an active entry", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await writeFile(sessionFile, "");
    await expect(readOmpSessionHistory(sessionFile)).resolves.toEqual({
      entries: [],
      leafId: null,
    });
  });

  it("propagates missing-file errors", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    await expect(
      readOmpSessionHistory(path.join(directory, "missing.jsonl")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("marks a byte-limited partial final record incomplete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const first = {
      type: "message",
      id: "first",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    };
    const firstLine = `${JSON.stringify(first)}\n`;
    await writeFile(
      sessionFile,
      firstLine + JSON.stringify({ ...first, id: "second", parentId: "first" }),
    );
    await expect(
      readOmpSessionHistory(sessionFile, Buffer.byteLength(firstLine) + 10),
    ).resolves.toEqual({
      entries: [first],
      leafId: "first",
      incomplete: true,
    });
  });

  it.each([
    '{"type":"message","id":"lost",',
    JSON.stringify({ type: "message", message: { role: "assistant" } }),
  ])(
    "marks skipped history records incomplete without losing readable messages: %s",
    async (bad) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
      temporaryDirectories.push(directory);
      const sessionFile = path.join(directory, "session.jsonl");
      const entry = (id: string, timestamp: number) =>
        JSON.stringify({
          type: "message",
          id,
          parentId: null,
          message: {
            role: "assistant",
            timestamp,
            model: "model",
            usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0 },
          },
        });
      await writeFile(sessionFile, `${entry("first", 1)}\n${bad}\n${entry("last", 2)}\n`);
      const history = await readOmpSessionHistory(sessionFile);
      expect(history.entries).toHaveLength(2);
      expect(history.leafId).toBe("last");
      expect(ompUsageHistory(history)).toMatchObject({
        complete: false,
        requests: [
          expect.objectContaining({ requestId: "t1" }),
          expect.objectContaining({ requestId: "t2" }),
        ],
      });
    },
  );

  it("bounds the history read at the requested byte limit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    const first = `${JSON.stringify({
      type: "message",
      id: "entry-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    })}\n`;
    const second = `${JSON.stringify({
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
    })}\n`;
    await writeFile(sessionFile, `${first}${second}`);

    const bounded = await readOmpSessionHistory(sessionFile, Buffer.byteLength(first));
    expect(bounded.entries).toHaveLength(1);
    expect(bounded.leafId).toBe("entry-1");

    const unbounded = await readOmpSessionHistory(sessionFile);
    expect(unbounded.entries).toHaveLength(2);
    expect(unbounded.leafId).toBe("entry-2");
  });
});
