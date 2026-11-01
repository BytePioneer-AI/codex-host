import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { CODEBUDDY_RUNTIME_PROFILE, type CodeBuddyRuntimeProfile } from "../src/common.js";
import { codeBuddyProjectSlug } from "../src/history.js";
import { CodeBuddySessionImport } from "../src/session-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-codebuddy-import-")));
  roots.push(root);
  const config = path.join(root, "config");
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(config, { recursive: true });
  const variable = profile.configDirectoryEnvironmentVariables[0] ?? "CODEBUDDY_CONFIG_DIR";
  const environment = { [variable]: config, HOME: root };
  const rows = (id: string, sessionCwd = cwd, text = "First\n prompt") => [
    { type: "session-meta", id: "meta", sessionId: id, timestamp: 1_000 },
    {
      id: "u1",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      timestamp: 2_000,
      sessionId: id,
      cwd: sessionCwd,
    },
    { id: "a1", type: "message", role: "assistant", content: [], timestamp: 3_000, sessionId: id },
  ];
  async function save(
    id: string,
    options: { project?: string; rows?: unknown[]; raw?: string } = {},
  ): Promise<string> {
    const directory = path.join(
      config,
      "projects",
      options.project ?? codeBuddyProjectSlug(cwd, profile),
    );
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${id}.jsonl`);
    await writeFile(
      file,
      options.raw ?? `${(options.rows ?? rows(id)).map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    return file;
  }
  return {
    root,
    config,
    cwd,
    environment,
    rows,
    save,
    importer: new CodeBuddySessionImport(environment, profile),
  };
}

describe("CodeBuddy native Session import discovery", () => {
  it("lists resumable Sessions with browser-safe metadata and never writes", async () => {
    const f = await fixture();
    const file = await f.save("s-plain");
    await f.save("s-ai", {
      rows: [...f.rows("s-ai"), { type: "ai-title", aiTitle: "AI title", timestamp: 4_000 }],
    });
    await f.save("s-custom", {
      rows: [
        ...f.rows("s-custom"),
        { type: "ai-title", aiTitle: "AI title", timestamp: 4_000 },
        { type: "custom-title", customTitle: " Custom\ttitle ", timestamp: 5_000 },
      ],
    });
    // The native client may store a project under another directory encoding.
    await f.save("s-other-encoding", { project: "Some.Other-Encoding" });
    const before = await readFile(file, "utf8");

    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const byId = new Map(listed.value.map((candidate) => [candidate.nativeSessionId, candidate]));
    expect(byId.get("s-plain")).toEqual({
      nativeSessionId: "s-plain",
      title: "First prompt",
      updatedAt: 3_000,
      cwd: f.cwd,
      running: null,
    });
    expect(byId.get("s-ai")).toMatchObject({ title: "AI title", updatedAt: 4_000 });
    expect(byId.get("s-custom")).toMatchObject({ title: "Custom title", updatedAt: 5_000 });
    expect(byId.has("s-other-encoding")).toBe(true);
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(f.config);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("skips Sessions that cannot be resumed without hiding the others", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other");
    await mkdir(other);
    await f.save("s-ok");
    await f.save("s-meta-only", { rows: [{ type: "session-meta", sessionId: "s-meta-only" }] });
    await f.save("s-invalid-row", { raw: `${JSON.stringify(f.rows("s-invalid-row")[1])}\n{bad\n` });
    await f.save("s-empty", { raw: "" });
    // Rows of another Session identity or directory fail resume's ownership check.
    await f.save("s-foreign", {
      rows: [...f.rows("s-foreign"), { id: "x", type: "message", sessionId: "s-someone-else" }],
    });
    await f.save("s-two-dirs", {
      rows: [...f.rows("s-two-dirs"), { id: "x", type: "summary", cwd: other }],
    });
    await f.save("s-gone", { rows: f.rows("s-gone", path.join(f.root, "missing")) });
    await f.save("s-relative", { rows: f.rows("s-relative", "relative") });
    await f.save("bad id!");
    const project = path.join(f.config, "projects", codeBuddyProjectSlug(f.cwd));
    // Subagent transcripts under a Session directory are not main Sessions.
    await mkdir(path.join(project, "s-ok"));
    await writeFile(path.join(project, "s-ok", "child.jsonl"), "{}\n");
    await writeFile(path.join(project, "notes.txt"), "x");
    await symlink(path.join(project, "s-ok.jsonl"), path.join(project, "s-link.jsonl"));

    const listed = await f.importer.listCandidates();
    expect(listed).toMatchObject({ ok: true, value: [{ nativeSessionId: "s-ok" }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    for (const id of ["s-meta-only", "s-foreign", "s-gone", "s-link", "child", "s-unknown"]) {
      expect(await f.importer.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    }
  });

  it("reports a Session registered by a live process as running and others as unknown", async () => {
    const f = await fixture();
    await f.save("s-live");
    await f.save("s-stale");
    await f.save("s-idle");
    const markers = path.join(f.config, "sessions");
    await mkdir(markers);
    await writeFile(
      path.join(markers, "1.json"),
      JSON.stringify({ pid: process.pid, sessionId: "s-live" }),
    );
    await writeFile(
      path.join(markers, "2.json"),
      JSON.stringify({ pid: 2_147_483_646, sessionId: "s-stale" }),
    );
    await writeFile(path.join(markers, "3.json"), "{half written");
    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    expect(
      Object.fromEntries(
        listed.value.map(({ nativeSessionId, running }) => [nativeSessionId, running]),
      ),
    ).toEqual({ "s-live": true, "s-stale": null, "s-idle": null });
    expect(await f.importer.resolveCandidate("s-live")).toMatchObject({
      ok: true,
      value: { candidate: { running: true } },
    });
  });

  it("treats one identity under two projects as not importable", async () => {
    const f = await fixture();
    await f.save("s-dup");
    await f.save("s-dup", { project: "another-project" });
    await f.save("s-single", { project: "another-project" });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-single" }],
    });
    expect(await f.importer.resolveCandidate("s-dup")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("uses the product profile for identity, storage root and Fork-capable placement", async () => {
    const profile: CodeBuddyRuntimeProfile = {
      ...CODEBUDDY_RUNTIME_PROFILE,
      harnessId: "workbuddy" as CodeBuddyRuntimeProfile["harnessId"],
      displayName: "WorkBuddy",
      configDirectoryEnvironmentVariables: ["WORKBUDDY_CONFIG_DIR"],
      projectDirectoryName: (cwd) => cwd.replace(/[/\\:]/gu, "-").replace(/^-+/u, ""),
      historyCapabilities: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
    };
    const f = await fixture(profile);
    await f.save("s-primary");
    // A Fork-capable profile resumes only from the project's primary directory.
    await f.save("s-elsewhere", { project: "not-the-primary-directory" });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-primary" }],
    });
    expect(await f.importer.resolveCandidate("s-primary")).toMatchObject({
      ok: true,
      value: { nativeRef: { harnessId: "workbuddy", nativeSessionId: "s-primary" } },
    });
    expect(await f.importer.resolveCandidate("s-elsewhere")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound", message: "WorkBuddy Session is no longer importable" },
    });
  });

  it("re-reads the selected Session and stops after Adapter close", async () => {
    const f = await fixture();
    expect(await f.importer.listCandidates()).toEqual({ ok: true, value: [] });
    const file = await f.save("s-a");
    const adapter = new CodeBuddyAdapter({ environment: f.environment });
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toEqual({
      ok: true,
      value: {
        candidate: expect.objectContaining({ nativeSessionId: "s-a", cwd: f.cwd }),
        nativeRef: { harnessId: "codebuddy", nativeSessionId: "s-a", formatVersion: 1 },
      },
    });
    await rm(file);
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
