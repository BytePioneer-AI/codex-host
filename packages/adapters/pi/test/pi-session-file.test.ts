import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPiSessionCwd } from "../src/pi-session-file.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-pi-session-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi Session file verification", () => {
  it("confirms the persisted Session identity and cwd", async () => {
    const root = await temporaryDirectory();
    const cwd = path.join(root, "worktree");
    const sessionFile = path.join(root, "session.jsonl");
    await mkdir(cwd);
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "derived-session", cwd })}\n`,
    );

    await expect(
      verifyPiSessionCwd({ sessionFile, sessionId: "derived-session", expectedCwd: cwd }),
    ).resolves.toBeUndefined();
  });

  it("rejects a mismatched Session identity or cwd", async () => {
    const root = await temporaryDirectory();
    const expectedCwd = path.join(root, "expected");
    const actualCwd = path.join(root, "actual");
    const sessionFile = path.join(root, "session.jsonl");
    await Promise.all([mkdir(expectedCwd), mkdir(actualCwd)]);
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "actual-session",
        cwd: actualCwd,
      })}\n`,
    );

    await expect(
      verifyPiSessionCwd({
        sessionFile,
        sessionId: "expected-session",
        expectedCwd,
      }),
    ).rejects.toThrow("identity does not match");
    await expect(
      verifyPiSessionCwd({ sessionFile, sessionId: "actual-session", expectedCwd }),
    ).rejects.toThrow("did not bind the requested cwd");
  });
});
