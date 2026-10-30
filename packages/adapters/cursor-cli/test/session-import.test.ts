import { randomUUID } from "node:crypto";
import { readFileSync, utimesSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessSessionImportCandidateSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CursorAdapter } from "../src/adapter.js";
import { CursorTransport } from "../src/transport.js";
import * as history from "../src/native-history.js";
import { nativeSession } from "./fixtures/native-session.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const directories: string[] = [];
const adapters: CursorAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(extra: NodeJS.ProcessEnv = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codexhost-cursor-import-")),
  );
  directories.push(root);
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const environment = { HOME: root, USERPROFILE: root, ...extra };
  const adapter = new CursorAdapter({ environment });
  adapters.push(adapter);
  const config = history.cursorConfigDirectory(environment);
  return { root, cwd, config, adapter, environment };
}

async function listed(adapter: CursorAdapter) {
  const result = await adapter.sessionImport.listCandidates();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("Cursor native ACP Session import", () => {
  it("lists only verified ACP metadata without starting a transport or changing files", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd, ["  hello\nworld\0  ", "second"]);
    const bytes = [readFileSync(item.metadata), readFileSync(item.database)];
    const prepare = vi.spyOn(CursorTransport.prototype, "prepare");
    const open = vi.spyOn(CursorTransport.prototype, "open");
    const candidates = await listed(f.adapter);
    expect(candidates).toEqual([
      {
        nativeSessionId: item.sessionId,
        cwd: f.cwd,
        title: "hello world",
        updatedAt: Math.floor((await fs.stat(item.database)).mtimeMs),
        running: null,
      },
    ]);
    expect(harnessSessionImportCandidateSchema.array().safeParse(candidates).success).toBe(true);
    const source = await f.adapter.sessionImport.resolveCandidate(item.sessionId);
    expect(source).toMatchObject({
      ok: true,
      value: {
        nativeRef: {
          harnessId: "cursor-cli",
          nativeSessionId: item.sessionId,
          formatVersion: 1,
          locator: { executionPolicy: "default" },
        },
      },
    });
    expect([readFileSync(item.metadata), readFileSync(item.database)]).toEqual(bytes);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"])(
    "uses %s consistently with native resume",
    async (variable) => {
      const f = await fixture();
      const custom = path.join(f.root, "custom");
      const adapter = new CursorAdapter({ environment: { ...f.environment, [variable]: custom } });
      adapters.push(adapter);
      const config = variable === "XDG_CONFIG_HOME" ? path.join(custom, "cursor") : custom;
      const selected = nativeSession(config, f.cwd);
      nativeSession(f.config, f.cwd, ["must not appear"]);
      expect((await listed(adapter)).map((item) => item.nativeSessionId)).toEqual([
        selected.sessionId,
      ]);
    },
  );

  it("treats a missing store as empty, but reports inaccessible or non-directory storage", async () => {
    const f = await fixture();
    expect(await listed(f.adapter)).toEqual([]);
    await fs.mkdir(f.config);
    await fs.writeFile(path.join(f.config, "acp-sessions"), "not a directory");
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    await fs.rm(path.join(f.config, "acp-sessions"));
    await fs.mkdir(path.join(f.config, "acp-sessions"));
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(
      Object.assign(new Error("private diagnostic"), { code: "EACCES" }),
    );
    const result = await f.adapter.sessionImport.listCandidates();
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });

  it("ignores empty, corrupt, incomplete, foreign-identity and missing-workspace stores", async () => {
    const f = await fixture();
    const good = nativeSession(f.config, f.cwd);
    nativeSession(f.config, f.cwd, []);
    const corrupt = nativeSession(f.config, f.cwd);
    await fs.writeFile(corrupt.database, "not sqlite");
    const missing = nativeSession(f.config, f.cwd);
    await fs.rm(missing.metadata);
    const foreign = nativeSession(f.config, f.cwd);
    const db = new DatabaseSync(foreign.database);
    db.prepare("UPDATE meta SET value=? WHERE key='0'").run(
      Buffer.from(
        JSON.stringify({ agentId: randomUUID(), latestRootBlobId: "0".repeat(64) }),
      ).toString("hex"),
    );
    db.close();
    nativeSession(f.config, path.join(f.root, "missing-project"));
    const invalid = nativeSession(f.config, f.cwd);
    await fs.writeFile(invalid.metadata, "{broken");
    expect((await listed(f.adapter)).map((item) => item.nativeSessionId)).toEqual([good.sessionId]);
    expect(await f.adapter.sessionImport.resolveCandidate(foreign.sessionId)).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("bounds title/metadata projection and does not expose non-candidate fields", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd, ["x".repeat(5_000)]);
    const oversized = nativeSession(f.config, f.cwd);
    await fs.writeFile(
      oversized.metadata,
      JSON.stringify({ cwd: f.cwd, extra: "x".repeat(1024 * 1024) }),
    );
    const candidates = await listed(f.adapter);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.nativeSessionId).toBe(item.sessionId);
    expect(candidates[0]?.title).toHaveLength(4_096);
    expect(Object.keys(candidates[0] ?? {}).sort()).toEqual([
      "cwd",
      "nativeSessionId",
      "running",
      "title",
      "updatedAt",
    ]);
  });

  it("uses current WAL activity rather than only the checkpointed database timestamp", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd);
    const writer = new DatabaseSync(item.database);
    try {
      writer.exec("PRAGMA journal_mode=WAL; UPDATE meta SET value=value WHERE key='0'");
      // Force a genuine WAL transaction, keeping the native history untouched.
      writer.exec("INSERT INTO meta VALUES('unrelated', 'test')");
      const wal = `${item.database}-wal`;
      const seconds = Date.now() / 1000 + 60;
      utimesSync(wal, seconds, seconds);
      expect(await listed(f.adapter)).toMatchObject([
        {
          nativeSessionId: item.sessionId,
          updatedAt: Math.floor((await fs.stat(wal)).mtimeMs),
          running: null,
        },
      ]);
    } finally {
      writer.close();
    }
  });

  it("does not enumerate normal CLI stores, IDE chats, or linked Session directories", async () => {
    const f = await fixture();
    const good = nativeSession(f.config, f.cwd);
    const hidden = nativeSession(path.join(f.root, "elsewhere"), f.cwd);
    await fs.symlink(
      hidden.directory,
      path.join(f.config, "acp-sessions", hidden.sessionId),
      "junction",
    );
    await fs.mkdir(path.join(f.config, "chats", randomUUID()), { recursive: true });
    expect((await listed(f.adapter)).map((item) => item.nativeSessionId)).toEqual([good.sessionId]);
    expect(await f.adapter.sessionImport.resolveCandidate(hidden.sessionId)).toMatchObject({
      ok: false,
    });
  });

  it.skipIf(process.platform === "win32")("rejects linked metadata and databases", async () => {
    const f = await fixture();
    const good = nativeSession(f.config, f.cwd);
    const other = nativeSession(f.config, f.cwd);
    await fs.rm(other.metadata);
    await fs.symlink(good.metadata, other.metadata);
    expect((await listed(f.adapter)).map((item) => item.nativeSessionId)).toEqual([good.sessionId]);
    await fs.rm(other.metadata);
    await fs.writeFile(other.metadata, JSON.stringify({ cwd: f.cwd }));
    await fs.rm(other.database);
    await fs.symlink(good.database, other.database);
    expect((await listed(f.adapter)).map((item) => item.nativeSessionId)).toEqual([good.sessionId]);
  });

  it("rechecks selected metadata and deletion, rejecting traversal without scanning other stores", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd);
    await listed(f.adapter);
    const nextCwd = path.join(f.root, "moved-project");
    await fs.mkdir(nextCwd);
    await fs.writeFile(item.metadata, JSON.stringify({ cwd: nextCwd }));
    expect(await f.adapter.sessionImport.resolveCandidate(item.sessionId)).toMatchObject({
      ok: true,
      value: { candidate: { cwd: nextCwd } },
    });
    await fs.rm(item.database);
    expect(await f.adapter.sessionImport.resolveCandidate(item.sessionId)).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    expect(await f.adapter.sessionImport.resolveCandidate("../../outside")).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("skips a changing store while listing and refuses it during import resolution", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd);
    const read = history.readCursorNativeTurns;
    let seconds = Date.now() / 1000;
    vi.spyOn(history, "readCursorNativeTurns").mockImplementation((...args) => {
      const value = read(...args);
      seconds += 10;
      utimesSync(item.metadata, seconds, seconds);
      return value;
    });
    expect(await listed(f.adapter)).toEqual([]);
    expect(await f.adapter.sessionImport.resolveCandidate(item.sessionId)).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
  });

  it("aborts pending discovery and rejects new requests after Adapter close", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd);
    const pending = f.adapter.sessionImport.listCandidates();
    await f.adapter.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({ ok: false });
    expect(await f.adapter.sessionImport.resolveCandidate(item.sessionId)).toMatchObject({
      ok: false,
    });
  });

  it("resumes the resolved native identity and continues the same history through Adapter open", async () => {
    const f = await fixture();
    const item = nativeSession(f.config, f.cwd);
    const resolved = await f.adapter.sessionImport.resolveCandidate(item.sessionId);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
      id,
    ) {
      this.sessionId = id ?? "";
      this.replay = item.turns.map((turn) => ({
        sessionId: this.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.text } },
      }));
      return {
        sessionId: this.sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "model",
            options: [{ value: "model", name: "Model" }],
          },
        ],
      };
    });
    vi.spyOn(CursorTransport.prototype, "prompt").mockImplementation(async function (
      this: CursorTransport,
      text,
      callbacks,
    ) {
      callbacks.update({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "continued" },
        },
      });
      item.turns.push({ id: randomUUID(), text });
      item.save();
      return { stopReason: "end_turn" };
    });
    const opened = await f.adapter.open({
      kind: "resume",
      cwd: resolved.value.candidate.cwd,
      nativeRef: resolved.value.nativeRef,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(open).toHaveBeenCalledWith(item.sessionId);
    expect(opened.value.initialState.nativeRef).toEqual(resolved.value.nativeRef);
    expect(await opened.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: { nativeTurnKey: item.turns[0]?.id } }] },
    });
    const events: HarnessOutput[] = [];
    const drained = (async () => {
      for await (const event of opened.value.outputs) events.push(event);
    })();
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("continued-turn"),
      input: [{ type: "text", text: "continue" }],
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: expect.objectContaining({ status: "succeeded" }),
            nativeTurnRef: expect.objectContaining({
              nativeSessionId: item.sessionId,
              nativeTurnKey: item.turns[1]?.id,
            }),
          }),
        }),
      ),
    );
    await opened.value.close();
    await drained;
  });
});
