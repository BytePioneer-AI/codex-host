import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OmpAdapter } from "../src/omp-adapter.js";
import { OmpSessionImport, ompSessionImportDirectory } from "../src/session-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-import-")));
  roots.push(root);
  const agent = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  const environment = { PI_CODING_AGENT_DIR: agent, HOME: root };
  const entries = (
    id: string,
    options: { cwd?: string; title?: string; prompt?: unknown } = {},
  ) => [
    { type: "title", v: 1, title: options.title ?? "", updatedAt: "2026-01-01T00:00:00.000Z" },
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: options.cwd ?? cwd,
    },
    { type: "model_change", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "user",
        content: options.prompt ?? [{ type: "text", text: "First\n prompt" }],
        timestamp: 1_767_225_602_000,
      },
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];
  async function save(
    id: string,
    options: { project?: string; rows?: unknown[]; raw?: string; directory?: string } = {},
  ): Promise<string> {
    const directory =
      options.directory ?? path.join(agent, "sessions", options.project ?? "-project");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    await writeFile(
      file,
      options.raw ??
        `${(options.rows ?? entries(id)).map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    return file;
  }
  return {
    root,
    agent,
    cwd,
    environment,
    entries,
    save,
    importer: new OmpSessionImport(environment),
  };
}

describe("OMP native Session import discovery", () => {
  it("follows OMP's storage variables", () => {
    // Windows reads USERPROFILE, so both home variables point at the same fake home.
    const home = { HOME: "/home/u", USERPROFILE: "/home/u" };
    expect(ompSessionImportDirectory(home)).toEqual({
      directory: path.join("/home/u", ".omp", "agent", "sessions"),
      flat: false,
    });
    expect(ompSessionImportDirectory({ ...home, PI_CODING_AGENT_DIR: "~/alt" })).toEqual({
      directory: path.resolve("/home/u", "alt", "sessions"),
      flat: false,
    });
    expect(
      ompSessionImportDirectory({
        ...home,
        PI_CODING_AGENT_DIR: "/ignored",
        PI_CODING_AGENT_SESSION_DIR: "/flat/sessions",
      }),
    ).toEqual({ directory: path.resolve("/flat/sessions"), flat: true });
  });

  it("lists resumable Sessions with browser-safe metadata and never writes", async () => {
    const f = await fixture();
    const file = await f.save("s-plain");
    await f.save("s-titled", { rows: f.entries("s-titled", { title: " Native\ttitle " }) });
    await f.save("s-string", { rows: f.entries("s-string", { prompt: "String prompt" }) });
    const before = await readFile(file, "utf8");

    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const byId = new Map(listed.value.map((candidate) => [candidate.nativeSessionId, candidate]));
    expect(byId.get("s-plain")).toEqual({
      nativeSessionId: "s-plain",
      title: "First prompt",
      // The last user or assistant activity, not the padded title record.
      updatedAt: Date.parse("2026-01-01T00:00:03.000Z"),
      cwd: f.cwd,
      running: null,
    });
    expect(byId.get("s-titled")).toMatchObject({ title: "Native title" });
    expect(byId.get("s-string")).toMatchObject({ title: "String prompt" });
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    // The locator is a Host-side reference; the browser listing never carries native paths.
    expect(JSON.stringify(listed)).not.toContain(f.agent);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("skips Sessions that cannot be resumed without hiding the others", async () => {
    const f = await fixture();
    const ok = await f.save("s-ok");
    await f.save("s-no-header", {
      rows: f.entries("s-no-header").filter((row) => row.type !== "session"),
    });
    await f.save("s-two-headers", {
      rows: [...f.entries("s-two-headers"), { type: "session", id: "other", cwd: f.cwd }],
    });
    await f.save("s-no-user", { rows: f.entries("s-no-user").slice(0, 3) });
    // The leaf OMP resumes from sits on a branch without any user message.
    await f.save("s-leaf-without-user", {
      rows: [
        ...f.entries("s-leaf-without-user"),
        { type: "model_change", id: "e9", parentId: "e1", timestamp: "2026-01-01T00:00:09.000Z" },
      ],
    });
    await f.save("s-relative", { rows: f.entries("s-relative", { cwd: "relative" }) });
    await f.save("s-gone", { rows: f.entries("s-gone", { cwd: path.join(f.root, "missing") }) });
    await f.save("s-empty", { raw: "" });
    const project = path.dirname(ok);
    // Subagent transcripts sit one level below the Session file and are not main Sessions.
    await f.save("s-child", { directory: path.join(project, "2026-01-01T00-00-00-000Z_s-ok") });
    await writeFile(path.join(project, "notes.txt"), "x");
    await writeFile(path.join(f.agent, "sessions", "stray.jsonl"), "{}\n");
    await symlink(ok, path.join(project, "link.jsonl"));

    const listed = await f.importer.listCandidates();
    expect(listed).toMatchObject({ ok: true, value: [{ nativeSessionId: "s-ok" }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    for (const id of ["s-no-user", "s-leaf-without-user", "s-gone", "s-child", "s-unknown"]) {
      expect(await f.importer.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    }
  });

  it("tolerates an unreadable line the way OMP's own history reader does", async () => {
    const f = await fixture();
    const rows = f.entries("s-torn").map((row) => JSON.stringify(row));
    await f.save("s-torn", { raw: `${rows.slice(0, 4).join("\n")}\n{torn\n${rows[4]}\n` });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-torn", title: "First prompt" }],
    });
  });

  it("treats one identity in two files as not importable", async () => {
    const f = await fixture();
    await f.save("s-dup");
    await f.save("s-dup", { project: "-other" });
    await f.save("s-single", { project: "-other" });
    expect(await f.importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-single" }],
    });
    expect(await f.importer.resolveCandidate("s-dup")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("scans an explicit flat Session directory without descending", async () => {
    const f = await fixture();
    const flat = path.join(f.root, "flat");
    await f.save("s-flat", { directory: flat });
    await f.save("s-nested", { directory: path.join(flat, "nested") });
    const importer = new OmpSessionImport({ ...f.environment, PI_CODING_AGENT_SESSION_DIR: flat });
    expect(await importer.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "s-flat" }],
    });
  });

  it("returns the Session file as the resume locator and stops after Adapter close", async () => {
    const f = await fixture();
    expect(await f.importer.listCandidates()).toEqual({ ok: true, value: [] });
    const file = await f.save("s-a");
    const createTransport = vi.fn();
    const adapter = new OmpAdapter({ environment: f.environment }, { createTransport });
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toEqual({
      ok: true,
      value: {
        candidate: expect.objectContaining({ nativeSessionId: "s-a", cwd: f.cwd }),
        nativeRef: {
          harnessId: "omp",
          nativeSessionId: "s-a",
          locator: { sessionFile: file },
          formatVersion: 1,
        },
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
    // Discovery never starts an OMP process.
    expect(createTransport).not.toHaveBeenCalled();
  });
});
