import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AntigravitySessionImport } from "../src/session-import.js";

let home: string;
let root: string;
let cwd: string;
let summaries: string;
let discovery: AntigravitySessionImport;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agy-session-import-"));
  root = path.join(home, ".gemini", "antigravity-cli");
  cwd = path.join(home, "workspace with spaces");
  summaries = path.join(root, "conversation_summaries.db");
  await mkdir(cwd, { recursive: true });
  discovery = new AntigravitySessionImport({ HOME: home, USERPROFILE: home });
});
afterEach(async () => {
  await discovery.close();
  await rm(home, { recursive: true, force: true });
});

async function store(): Promise<void> {
  await mkdir(path.join(root, "conversations"), { recursive: true });
  const db = new DatabaseSync(summaries);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER,
      last_modified_time TEXT, workspace_uris TEXT, status TEXT,
      parent_conversation_id TEXT, killed INTEGER
    )`);
  } finally {
    db.close();
  }
}

async function conversation(
  fields: Record<string, SQLInputValue> = {},
  createNativeDb = true,
): Promise<string> {
  await store();
  const id = randomUUID();
  const row = {
    conversation_id: id,
    title: "Example title",
    preview: "Preview",
    step_count: 2,
    last_modified_time: "2026-11-14 15:19:32.602201+00:00",
    workspace_uris: JSON.stringify([pathToFileURL(cwd).href]),
    status: "CASCADE_RUN_STATUS_IDLE",
    parent_conversation_id: "",
    killed: 0,
    ...fields,
  };
  const db = new DatabaseSync(summaries);
  try {
    db.prepare(
      `INSERT INTO conversation_summaries VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    ).run(...Object.values(row));
  } finally {
    db.close();
  }
  const actualId = String(row.conversation_id);
  if (createNativeDb) {
    const native = new DatabaseSync(path.join(root, "conversations", `${actualId}.db`));
    native.exec("CREATE TABLE trajectory (id TEXT)");
    native.close();
  }
  return actualId;
}

function update(id: string, assignment: string): void {
  const db = new DatabaseSync(summaries);
  try {
    db.prepare(`UPDATE conversation_summaries SET ${assignment} WHERE conversation_id = ?`).run(id);
  } finally {
    db.close();
  }
}

describe("Antigravity read-only Session import", () => {
  it("treats a missing store as empty without creating native storage", async () => {
    expect(await discovery.listCandidates()).toEqual({ ok: true, value: [] });
    await expect(readFile(summaries)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await discovery.resolveCandidate(randomUUID())).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound", retryable: false },
    });
  });

  it("filters Subagents, empty/killed Sessions, invalid workspaces and missing native databases", async () => {
    await conversation({ parent_conversation_id: randomUUID() });
    await conversation({ parent_conversation_id: " " });
    await conversation({ step_count: 0 });
    await conversation({ step_count: -2 });
    await conversation({ killed: 1 });
    await conversation({}, false);
    await conversation({ workspace_uris: "not json" });
    await conversation({
      workspace_uris: JSON.stringify(["relative/path", "https://example.com"]),
    });
    await conversation({ workspace_uris: JSON.stringify(["file://remote-host/workspace"]) });
    await conversation({ workspace_uris: JSON.stringify(["file:///bad%00path"]) });
    await conversation({ workspace_uris: JSON.stringify([path.join(home, "missing-workspace")]) });
    await conversation({ conversation_id: "invalid-native-id" });
    const valid = await conversation({ parent_conversation_id: null });
    const result = await discovery.listCandidates();
    expect(result).toMatchObject({ ok: true, value: [{ nativeSessionId: valid }] });
    if (!result.ok) throw new Error("Expected candidates");
    expect(result.value).toHaveLength(1);
    expect(await discovery.resolveCandidate("../not-a-session")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound", retryable: false },
    });
  });

  it("skips hooks workspaces and prefers the first real local directory", async () => {
    const hooks = path.join(home, ".codexhost", "antigravity-history", "hooks", "session");
    await mkdir(hooks, { recursive: true });
    await conversation({ workspace_uris: JSON.stringify([pathToFileURL(hooks).href]) });
    const id = await conversation({
      workspace_uris: JSON.stringify([pathToFileURL(hooks).href, pathToFileURL(cwd).href, home]),
    });
    expect(await discovery.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: id, cwd }],
    });
    const resolved = await discovery.resolveCandidate(id);
    expect(resolved).toMatchObject({ ok: true, value: { candidate: { cwd } } });
  });

  it("falls back from blank titles to preview, then first USER_INPUT, then null", async () => {
    const preview = await conversation({ title: " \n", preview: " Preview\n title " });
    const fromPrompt = await conversation({ title: "", preview: "" });
    const noTitle = await conversation({ title: "", preview: "" });
    const file = path.join(
      root,
      "brain",
      fromPrompt,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [
        "{bad json",
        JSON.stringify({ type: "PLANNER_RESPONSE", content: "not a user title" }),
        JSON.stringify({ type: "USER_INPUT", content: " First\n user request " }),
        JSON.stringify({ type: "USER_INPUT", content: "Later request" }),
      ].join("\n"),
    );
    const result = await discovery.listCandidates();
    expect(result).toMatchObject({
      ok: true,
      value: [
        { nativeSessionId: preview, title: "Preview title" },
        { nativeSessionId: fromPrompt, title: "First user request" },
        { nativeSessionId: noTitle, title: null },
      ],
    });
  });

  it("revalidates selected Sessions rather than trusting a previous listing", async () => {
    const missingDb = await conversation();
    const child = await conversation();
    const removed = await conversation();
    expect(await discovery.listCandidates()).toMatchObject({ ok: true });
    await rm(path.join(root, "conversations", `${missingDb}.db`));
    update(child, "parent_conversation_id = 'now-a-subagent'");
    const db = new DatabaseSync(summaries);
    db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(removed);
    db.close();
    for (const id of [missingDb, child, removed, randomUUID()]) {
      expect(await discovery.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound", retryable: false, message: expect.any(String) },
      });
    }
  });

  it("does not modify either database during discovery", async () => {
    const id = await conversation();
    const native = path.join(root, "conversations", `${id}.db`);
    const before = await Promise.all([readFile(summaries), readFile(native)]);
    expect(await discovery.listCandidates()).toMatchObject({ ok: true });
    expect(await discovery.resolveCandidate(id)).toMatchObject({ ok: true });
    expect(await Promise.all([readFile(summaries), readFile(native)])).toEqual(before);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips unreadable conversation files without hiding other candidates",
    async () => {
      const unreadable = await conversation();
      const readable = await conversation();
      const file = path.join(root, "conversations", `${unreadable}.db`);
      await chmod(file, 0o000);
      try {
        expect(await discovery.listCandidates()).toMatchObject({
          ok: true,
          value: [{ nativeSessionId: readable }],
        });
        expect(await discovery.resolveCandidate(unreadable)).toMatchObject({
          ok: false,
          error: { code: "sessionNotFound" },
        });
      } finally {
        await chmod(file, 0o600);
      }
    },
  );

  it("bounds corrupt-store failures, cancellation and closed capability reads", async () => {
    await store();
    await writeFile(summaries, "not a SQLite database");
    expect(await discovery.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    expect(await discovery.listCandidates({ signal: AbortSignal.abort() })).toMatchObject({
      ok: false,
    });
    await discovery.close();
    await discovery.close();
    expect(await discovery.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(await discovery.resolveCandidate(randomUUID())).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
});
