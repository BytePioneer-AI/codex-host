import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  jsonlHeader,
  jsonlRecords,
  jsonlUsageSources,
  nativeTimeMs,
  parseHarnessUsageEntry,
  withUsageSession,
} from "../src/usage-statistics.js";

let root: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "usage-sources-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("jsonlUsageSources", () => {
  it("lists non-empty .jsonl files within the depth, never following links", async () => {
    await mkdir(path.join(root, "project", "session", "subagents"), { recursive: true });
    await writeFile(path.join(root, "project", "main.jsonl"), "{}\n");
    await writeFile(path.join(root, "project", "empty.jsonl"), "");
    await writeFile(path.join(root, "project", "notes.txt"), "x");
    await writeFile(path.join(root, "project", "session", "subagents", "agent.jsonl"), "{}\n");
    await symlink(path.join(root, "project"), path.join(root, "linked"));
    const shallow = await jsonlUsageSources(root, 1, signal);
    expect(shallow.map((source) => path.relative(root, source.id))).toEqual([
      path.join("project", "main.jsonl"),
    ]);
    const deep = await jsonlUsageSources(root, 3, signal);
    expect(deep.map((source) => path.relative(root, source.id)).sort()).toEqual([
      path.join("project", "main.jsonl"),
      path.join("project", "session", "subagents", "agent.jsonl"),
    ]);
    expect(await jsonlUsageSources(path.join(root, "missing"), 3, signal)).toEqual([]);
  });

  it("changes the fingerprint when a file grows", async () => {
    const file = path.join(root, "a.jsonl");
    await writeFile(file, "{}\n");
    const [before] = await jsonlUsageSources(root, 0, signal);
    await writeFile(file, "{}\n{}\n");
    const [after] = await jsonlUsageSources(root, 0, signal);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });
});

it("parses only marked, well-formed object lines", async () => {
  const file = path.join(root, "a.jsonl");
  await writeFile(
    file,
    ['{"k":"hit","n":1}', '{"k":"miss"}', "{bad hit", '["hit"]', ""].join("\n"),
  );
  const records = [];
  for await (const record of jsonlRecords(file, "hit", signal)) records.push(record);
  expect(records).toEqual([{ k: "hit", n: 1 }]);
});

it("validates optional native credits without treating missing values as zero", () => {
  const entry = { id: "r", occurredAtMs: 1, inputTokens: 10, outputTokens: 2 };
  expect(parseHarnessUsageEntry(entry)).not.toHaveProperty("credits");
  for (const credits of [0, 0.25, 14.81]) {
    expect(parseHarnessUsageEntry({ ...entry, credits })).toMatchObject({ credits });
  }
  for (const credits of [-1, NaN, Infinity, "1", null]) {
    expect(parseHarnessUsageEntry({ ...entry, credits })).toBeNull();
  }
});

it("validates entries and native times", () => {
  const valid = {
    id: "r",
    occurredAtMs: 1,
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 2,
  };
  expect(parseHarnessUsageEntry(valid)).toEqual(valid);
  expect(parseHarnessUsageEntry({ ...valid, cacheWriteInputTokens: 7 })).toBeNull();
  expect(parseHarnessUsageEntry({ ...valid, reasoningOutputTokens: 3 })).toBeNull();
  expect(parseHarnessUsageEntry({ ...valid, model: "" })).toBeNull();
  expect(parseHarnessUsageEntry({ ...valid, id: "" })).toBeNull();
  expect(nativeTimeMs("2026-10-05T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 5));
  expect(nativeTimeMs(12.7)).toBe(12);
  expect(nativeTimeMs("not a date")).toBeNull();
});

describe("usage session attribution", () => {
  const entry = { id: "r", occurredAtMs: 1, inputTokens: 1, outputTokens: 1 };

  it("keeps valid session IDs and absolute directories and drops the rest", () => {
    expect(withUsageSession(entry, { sessionId: "s", cwd: "/work" })).toEqual({
      ...entry,
      sessionId: "s",
      cwd: "/work",
    });
    expect(withUsageSession(entry, { cwd: "C:\\work" })).toEqual({ ...entry, cwd: "C:\\work" });
    for (const cwd of ["", "relative/dir", "/a\u0000b", `/${"x".repeat(5000)}`]) {
      expect(withUsageSession(entry, { cwd })).toBe(entry);
    }
    expect(withUsageSession(entry, { sessionId: "", cwd: null })).toBe(entry);
    expect(withUsageSession(entry, { sessionId: "x".repeat(513) })).toBe(entry);
  });

  it("accepts a native cost and rejects one that is not a non-negative number", () => {
    expect(parseHarnessUsageEntry({ ...entry, costUsd: 0.25 })).toMatchObject({ costUsd: 0.25 });
    expect(parseHarnessUsageEntry({ ...entry, costUsd: 0 })).not.toBeNull();
    for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expect(parseHarnessUsageEntry({ ...entry, costUsd })).toBeNull();
    }
  });

  it("accepts only true as the mark that token counts are unknown", () => {
    expect(parseHarnessUsageEntry({ ...entry, tokensUnknown: true })).toMatchObject({
      tokensUnknown: true,
    });
    expect(parseHarnessUsageEntry({ ...entry, tokensUnknown: false })).toBeNull();
  });

  it("rejects entries from an Adapter with malformed attribution", () => {
    expect(parseHarnessUsageEntry({ ...entry, sessionId: "s", cwd: "/w" })).not.toBeNull();
    expect(parseHarnessUsageEntry({ ...entry, sessionId: 5 })).toBeNull();
    expect(parseHarnessUsageEntry({ ...entry, cwd: "relative" })).toBeNull();
  });

  it("reads a header from the first lines only", async () => {
    const file = path.join(root, "s.jsonl");
    await writeFile(
      file,
      [
        "not json",
        JSON.stringify({ type: "title" }),
        JSON.stringify({ type: "session", id: "s" }),
        JSON.stringify({ type: "session", id: "late" }),
      ].join("\n"),
    );
    const isSession = (record: Record<string, unknown>) => record.type === "session";
    expect(await jsonlHeader(file, isSession, signal)).toEqual({ type: "session", id: "s" });
    expect(await jsonlHeader(file, isSession, signal, 2)).toBeNull();
    expect(await jsonlHeader(file, () => false, signal)).toBeNull();
  });
});
