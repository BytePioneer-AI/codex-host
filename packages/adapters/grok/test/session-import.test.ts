import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/grok-adapter.js";
import { GrokSessionImport } from "../src/session-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function userUpdate(sessionId: string, text: string): unknown {
  return {
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
    },
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-grok-import-")));
  roots.push(root);
  const home = path.join(root, "grok");
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const environment = { GROK_HOME: home, HOME: root };
  async function save(
    id: string,
    options: {
      cwd?: string;
      workspace?: string;
      summary?: Record<string, unknown>;
      updates?: unknown[] | null;
    } = {},
  ): Promise<string> {
    const sessionCwd = options.cwd ?? cwd;
    const directory = path.join(
      home,
      "sessions",
      options.workspace ?? encodeURIComponent(sessionCwd),
      id,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify({
        info: { id, cwd: sessionCwd },
        generated_title: "Native title",
        updated_at: "2026-02-03T04:05:06.000Z",
        last_active_at: "2026-02-03T04:05:07.000Z",
        ...options.summary,
      }),
    );
    if (options.updates !== null) {
      await writeFile(
        path.join(directory, "updates.jsonl"),
        (
          options.updates ?? [
            { method: "_x.ai/session/update", params: { update: { sessionUpdate: "hook" } } },
            userUpdate(id, "First\n prompt"),
          ]
        )
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
    }
    return directory;
  }
  return { root, home, cwd, environment, save, importer: new GrokSessionImport(environment) };
}

describe("Grok native Session import discovery", () => {
  it("lists resumable Sessions with browser-safe metadata and never writes", async () => {
    const f = await fixture();
    const directory = await f.save("s-main");
    await f.save("s-fork", { summary: { session_kind: "fork", parent_session_id: "s-main" } });
    await f.save("s-untitled", {
      summary: { generated_title: " ", session_summary: null, last_active_at: 5, updated_at: "x" },
    });
    const before = await readFile(path.join(directory, "updates.jsonl"), "utf8");

    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const byId = new Map(listed.value.map((candidate) => [candidate.nativeSessionId, candidate]));
    expect(byId.get("s-main")).toEqual({
      nativeSessionId: "s-main",
      title: "Native title",
      updatedAt: Date.parse("2026-02-03T04:05:07.000Z"),
      cwd: f.cwd,
      running: null,
    });
    // A Fork is an ordinary resumable Session.
    expect(byId.has("s-fork")).toBe(true);
    // No native title: first user prompt. No usable native time: file time.
    expect(byId.get("s-untitled")).toMatchObject({ title: "First prompt" });
    expect(byId.get("s-untitled")?.updatedAt).toBeGreaterThan(1_600_000_000_000);
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(f.home);
    expect(await readFile(path.join(directory, "updates.jsonl"), "utf8")).toBe(before);
  });

  it("skips Sessions that cannot be resumed without hiding the others", async () => {
    const f = await fixture();
    await f.save("s-ok");
    await f.save("s-subagent", { summary: { session_kind: "subagent" } });
    await f.save("s-subagent-resume", { summary: { session_kind: "subagent_resume" } });
    await f.save("s-no-prompt", { updates: [{ method: "session/update", params: {} }] });
    await f.save("s-no-updates", { updates: null });
    await f.save("s-wrong-id", { summary: { info: { id: "other", cwd: f.cwd } } });
    await f.save("s-relative", { summary: { info: { id: "s-relative", cwd: "relative" } } });
    await f.save("s-gone", { cwd: path.join(f.root, "missing") });
    // Resume looks under the directory encoded from the cwd; a Session stored elsewhere is lost.
    await f.save("s-moved", { workspace: encodeURIComponent(path.join(f.root, "elsewhere")) });
    const workspace = path.join(f.home, "sessions", encodeURIComponent(f.cwd));
    await writeFile(path.join(workspace, "prompt_history.jsonl"), "{}");
    await writeFile(path.join(f.home, "sessions", "session_search.sqlite"), "");
    await mkdir(path.join(workspace, "s-empty"));
    await writeFile(path.join(workspace, "s-empty", "summary.json"), "{not json");
    await symlink(path.join(workspace, "s-ok"), path.join(workspace, "s-link"));

    const listed = await f.importer.listCandidates();
    expect(listed).toMatchObject({ ok: true, value: [{ nativeSessionId: "s-ok" }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    for (const id of ["s-subagent", "s-no-prompt", "s-moved", "s-link", "s-unknown"]) {
      expect(await f.importer.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    }
  });

  it("reports a Session held by a live Grok process as running and others as unknown", async () => {
    const f = await fixture();
    await f.save("s-live");
    await f.save("s-stale");
    await f.save("s-idle");
    await writeFile(
      path.join(f.home, "active_sessions.json"),
      JSON.stringify([
        { session_id: "s-live", pid: process.pid },
        // A registry entry whose process is gone proves nothing.
        { session_id: "s-stale", pid: 2_147_483_646 },
        { session_id: "s-idle" },
        "garbage",
      ]),
    );
    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const running = Object.fromEntries(
      listed.value.map((candidate) => [candidate.nativeSessionId, candidate.running]),
    );
    expect(running).toEqual({ "s-live": true, "s-stale": null, "s-idle": null });
    expect(await f.importer.resolveCandidate("s-live")).toMatchObject({
      ok: true,
      value: { candidate: { running: true } },
    });

    await writeFile(path.join(f.home, "active_sessions.json"), "{not json");
    expect(await f.importer.resolveCandidate("s-live")).toMatchObject({
      ok: true,
      value: { candidate: { running: null } },
    });
  });

  it("treats one identity under two workspaces as not importable", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other");
    await mkdir(other);
    await f.save("s-dup");
    await f.save("s-dup", { cwd: other });
    await f.save("s-single", { cwd: other });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-single", cwd: other }],
    });
    expect(await f.importer.resolveCandidate("s-dup")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("re-reads the selected Session and stops after Adapter close", async () => {
    const f = await fixture();
    expect(await f.importer.listCandidates()).toEqual({ ok: true, value: [] });
    const directory = await f.save("s-a");
    const adapter = new GrokAdapter({ environment: f.environment });
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toEqual({
      ok: true,
      value: {
        candidate: expect.objectContaining({ nativeSessionId: "s-a", cwd: f.cwd }),
        nativeRef: { harnessId: "grok", nativeSessionId: "s-a", formatVersion: 1 },
      },
    });
    await rm(directory, { recursive: true });
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
});
