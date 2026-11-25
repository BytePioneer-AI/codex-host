import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { KiroAdapter } from "../src/kiro-adapter.js";
import { KiroSessionImport } from "../src/session-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-kiro-import-")));
  roots.push(root);
  const home = path.join(root, "kiro");
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  const environment = { KIRO_HOME: home, HOME: root };
  const rows = (text = "First\n prompt") => [
    { id: "m1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: text } },
    { id: "m2", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "assistant", text: "ok" } },
  ];
  async function save(
    id: string,
    options: {
      workspace?: string;
      meta?: Record<string, unknown>;
      rows?: unknown[];
      rawMessages?: string;
    } = {},
  ): Promise<string> {
    const directory = path.join(home, "sessions", options.workspace ?? "ws1", id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session.json"),
      JSON.stringify({
        id,
        title: "Native title",
        workspacePaths: [cwd],
        lastModifiedAt: "2026-02-03T04:05:06.000Z",
        status: "idle",
        ...options.meta,
      }),
    );
    await writeFile(
      path.join(directory, "messages.jsonl"),
      options.rawMessages ?? (options.rows ?? rows()).map((row) => JSON.stringify(row)).join("\n"),
    );
    return directory;
  }
  return { root, home, cwd, environment, rows, save, importer: new KiroSessionImport(environment) };
}

describe("Kiro native Session import discovery", () => {
  it("lists resumable Sessions with browser-safe metadata and never writes", async () => {
    const f = await fixture();
    const directory = await f.save("sess_a");
    await f.save("sess_untitled", {
      meta: { title: "", lastModifiedAt: "not a date" },
      rows: f.rows(" Prompt\n\ttitle "),
    });
    const before = await readFile(path.join(directory, "messages.jsonl"), "utf8");

    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const byId = new Map(listed.value.map((candidate) => [candidate.nativeSessionId, candidate]));
    expect(byId.get("sess_a")).toEqual({
      nativeSessionId: "sess_a",
      title: "Native title",
      updatedAt: Date.parse("2026-02-03T04:05:06.000Z"),
      cwd: f.cwd,
      running: null,
    });
    // Without a native title the first user text is used; a bad date falls back to file time.
    expect(byId.get("sess_untitled")).toMatchObject({ title: "Prompt title", running: null });
    expect(byId.get("sess_untitled")?.updatedAt).toBeGreaterThan(1_600_000_000_000);
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(f.home);
    expect(await readFile(path.join(directory, "messages.jsonl"), "utf8")).toBe(before);
  });

  it("skips Sessions that cannot be resumed without hiding the others", async () => {
    const f = await fixture();
    await f.save("sess_ok");
    await f.save("sess_no_user", {
      rows: [{ id: "m", payload: { type: "assistant", text: "x" } }],
    });
    await f.save("sess_bad_rows", { rawMessages: "{not json" });
    await f.save("sess_wrong_id", { meta: { id: "sess_other" } });
    await f.save("sess_relative", { meta: { workspacePaths: ["relative/path"] } });
    await f.save("sess_no_workspace", { meta: { workspacePaths: [] } });
    await f.save("sess_gone", { meta: { workspacePaths: [path.join(f.root, "missing")] } });
    await f.save("sess_orphan_fork", {
      meta: { parentSessionId: "sess_missing_parent" },
      rows: [{ id: "s", payload: { type: "user", content: "x", operationType: "Summary" } }],
    });
    // Kiro's own bookkeeping directory and stray files are not workspaces.
    await f.save("sess_cli", { workspace: "cli" });
    await writeFile(path.join(f.home, "sessions", "stray.json"), "{}");
    await mkdir(path.join(f.home, "sessions", "ws1", "sess_empty"), { recursive: true });
    // Enumerated links are not followed into unrelated storage.
    await symlink(
      path.join(f.home, "sessions", "ws1", "sess_ok"),
      path.join(f.home, "sessions", "ws1", "sess_link"),
    );

    const listed = await f.importer.listCandidates();
    expect(listed).toMatchObject({ ok: true, value: [{ nativeSessionId: "sess_ok" }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    for (const id of ["sess_no_user", "sess_gone", "sess_cli", "sess_link", "sess_unknown"]) {
      expect(await f.importer.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    }
  });

  it("treats one identity under two workspaces as not importable", async () => {
    const f = await fixture();
    await f.save("sess_dup", { workspace: "ws1" });
    await f.save("sess_dup", { workspace: "ws2" });
    await f.save("sess_single", { workspace: "ws2" });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "sess_single" }],
    });
    expect(await f.importer.resolveCandidate("sess_dup")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("re-reads the selected Session at the commit boundary", async () => {
    const f = await fixture();
    const directory = await f.save("sess_a");
    expect(await f.importer.resolveCandidate("sess_a")).toEqual({
      ok: true,
      value: {
        candidate: expect.objectContaining({ nativeSessionId: "sess_a", title: "Native title" }),
        nativeRef: { harnessId: "kiro-cli", nativeSessionId: "sess_a", formatVersion: 1 },
      },
    });
    await f.save("sess_a", { meta: { title: "Renamed" } });
    expect(await f.importer.resolveCandidate("sess_a")).toMatchObject({
      ok: true,
      value: { candidate: { title: "Renamed" } },
    });
    await rm(directory, { recursive: true });
    expect(await f.importer.resolveCandidate("sess_a")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("reports an empty or missing store as no candidates and stops after Adapter close", async () => {
    const f = await fixture();
    expect(await f.importer.listCandidates()).toEqual({ ok: true, value: [] });

    await f.save("sess_a");
    const adapter = new KiroAdapter({ environment: f.environment });
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "sess_a" }],
    });
    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(await adapter.sessionImport.resolveCandidate("sess_a")).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
});
