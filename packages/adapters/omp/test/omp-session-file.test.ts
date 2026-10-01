import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyOmpSessionCwd, readOmpSessionHistory } from "../src/omp-session-file.js";

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
