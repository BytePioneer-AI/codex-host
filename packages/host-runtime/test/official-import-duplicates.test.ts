import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StoredThreadSummaryV1 } from "@codexhost/mapping-store";
import { afterEach, describe, expect, it } from "vitest";
import {
  isShadowedOfficialThread,
  readOfficialImportTimes,
} from "../src/official-import-duplicates.js";

const directories: string[] = [];
afterEach(() => Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true }))));

async function codexHome(contents?: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-imports-"));
  directories.push(directory);
  if (contents !== undefined)
    await writeFile(path.join(directory, "external_agent_session_imports.json"), contents);
  return directory;
}

function record(harnessId: string, nativeSessionId: string, locator?: unknown) {
  return {
    hostThreadId: `host-${nativeSessionId}`,
    harnessId,
    nativeSessionRef: { harnessId, nativeSessionId, formatVersion: 1, locator },
  } as unknown as StoredThreadSummaryV1;
}

describe("official import duplicates", () => {
  it("matches imports of Sessions codexhost lists and ignores unrelated ones", async () => {
    const home = await codexHome(
      JSON.stringify({
        records: [
          {
            source_path: "/u/.claude/projects/-p/claude-1.jsonl",
            imported_thread_id: "mirror-claude",
            imported_at: 10,
          },
          {
            source_path: "/u/.claude/projects/-p/standalone.jsonl",
            imported_thread_id: "mirror-standalone",
            imported_at: 10,
          },
          { source_path: "/u/pi/session.jsonl", imported_thread_id: "mirror-pi", imported_at: 10 },
          { source_path: 7 },
        ],
      }),
    );
    const times = await readOfficialImportTimes(home, [
      record("claude-code", "claude-1"),
      record("pi", "pi-1", { sessionFile: "/u/pi/session.jsonl" }),
    ]);
    expect([...times.keys()].sort()).toEqual(["mirror-claude", "mirror-pi"]);
  });

  it("compares normalized source paths with the host filesystem's Windows casing rules", async () => {
    const home = await codexHome(
      JSON.stringify({
        records: [
          {
            source_path: "C:/Users/Test/file.jsonl",
            imported_thread_id: "mirror",
            imported_at: 10,
          },
        ],
      }),
    );
    const times = await readOfficialImportTimes(home, [
      record("pi", "id", { sessionFile: "c:/users/test/File.jsonl" }),
    ]);
    expect(times.has("mirror")).toBe(process.platform === "win32");
  });

  it.each([undefined, "not json", '{"records":"x"}'])(
    "fails open for a missing or malformed index (%s)",
    async (contents) => {
      const times = await readOfficialImportTimes(await codexHome(contents), [
        record("claude-code", "claude-1"),
      ]);
      expect(times.size).toBe(0);
    },
  );

  it("hides only mirrors untouched since import and outside any section", () => {
    const times = new Map([["t", 10]]);
    expect(isShadowedOfficialThread(times, { id: "t", recencyAt: 10 })).toBe(true);
    expect(isShadowedOfficialThread(times, { id: "t", recencyAt: 11 })).toBe(false);
    expect(isShadowedOfficialThread(times, { id: "t" })).toBe(false);
    expect(
      isShadowedOfficialThread(times, { id: "t", recencyAt: 1, section: { id: "custom" } }),
    ).toBe(false);
    expect(isShadowedOfficialThread(times, { id: "other", recencyAt: 1 })).toBe(false);
  });
});
