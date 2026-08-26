import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyOmpSessionCwd } from "../src/omp-session-file.js";

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
});
