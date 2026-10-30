import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { KimiAdapter } from "../src/kimi-adapter.js";
import { KimiSessionImport } from "../src/session-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-kimi-import-")));
  roots.push(root);
  const home = path.join(root, "kimi-home");
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const environment = { KIMI_CODE_HOME: home, HOME: root };
  const index = path.join(home, "session_index.jsonl");
  const wire = (text = "First\n prompt") => [
    {
      type: "turn.prompt",
      agentId: "main",
      turnId: 0,
      time: 1_000,
      input: [{ type: "text", text }],
    },
    { type: "turn.ended", agentId: "main", turnId: 0, time: 2_000, reason: "completed" },
  ];
  async function save(
    id: string,
    options: {
      state?: Record<string, unknown>;
      wire?: unknown[] | null;
      rawWire?: string;
      index?: Record<string, unknown> | null;
      sessionDir?: string;
    } = {},
  ): Promise<string> {
    const sessionDir = options.sessionDir ?? path.join(home, "sessions", id);
    const mainHomeDir = path.join(sessionDir, "agents", "main");
    await mkdir(mainHomeDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ id, version: 2, cwd, ...options.state }),
    );
    if (options.wire !== null) {
      await writeFile(
        path.join(mainHomeDir, "wire.jsonl"),
        options.rawWire ??
          `${(options.wire ?? wire()).map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
    }
    if (options.index !== null) {
      await appendFile(
        index,
        `${JSON.stringify({ sessionId: id, sessionDir, workDir: cwd, ...options.index })}\n`,
      );
    }
    return sessionDir;
  }
  return {
    root,
    home,
    cwd,
    environment,
    index,
    wire,
    save,
    importer: new KimiSessionImport({ environment }),
  };
}

describe("Kimi native Session import discovery", () => {
  it("lists resumable Sessions with browser-safe metadata and never writes", async () => {
    const f = await fixture();
    const sessionDir = await f.save("s-plain");
    await f.save("s-titled", { state: { title: " Native\ttitle " } });
    const wireFile = path.join(sessionDir, "agents", "main", "wire.jsonl");
    const before = await readFile(wireFile, "utf8");

    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    const byId = new Map(listed.value.map((candidate) => [candidate.nativeSessionId, candidate]));
    expect(byId.get("s-plain")).toEqual({
      nativeSessionId: "s-plain",
      title: "First prompt",
      updatedAt: 2_000,
      cwd: f.cwd,
      running: null,
    });
    expect(byId.get("s-titled")).toMatchObject({ title: "Native title" });
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(f.home);
    expect(await readFile(wireFile, "utf8")).toBe(before);
    expect(await readFile(f.index, "utf8")).toContain("s-plain");
  });

  it("skips Sessions that cannot be resumed without hiding the others", async () => {
    const f = await fixture();
    await f.save("s-ok");
    await f.save("s-deleted");
    await appendFile(f.index, `${JSON.stringify({ sessionId: "s-deleted", deleted: true })}\n`);
    await f.save("s-unindexed", { index: null });
    await f.save("s-no-wire", { wire: null });
    await f.save("s-empty-wire", { rawWire: "" });
    await f.save("s-bad-wire", { rawWire: "{bad\n{}\n" });
    await f.save("s-wrong-state", { state: { id: "someone-else" } });
    await f.save("s-relative", { state: { cwd: "relative" } });
    await f.save("s-gone", { state: { cwd: path.join(f.root, "missing") } });
    // A directory outside Kimi's home is never read on the index's word.
    await f.save("s-outside", { sessionDir: path.join(f.root, "outside", "s-outside") });
    await appendFile(f.index, "{torn line\n");

    const listed = await f.importer.listCandidates();
    expect(listed).toMatchObject({ ok: true, value: [{ nativeSessionId: "s-ok" }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
    for (const id of ["s-deleted", "s-unindexed", "s-empty-wire", "s-outside", "s-unknown"]) {
      expect(await f.importer.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
    }
  });

  it("falls back to file time when the history carries no timestamps", async () => {
    const f = await fixture();
    await f.save("s-untimed", {
      wire: [
        { type: "turn.prompt", agentId: "main", turnId: 0, input: [{ type: "text", text: "x" }] },
      ],
    });
    const listed = await f.importer.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value[0]?.updatedAt).toBeGreaterThan(1_600_000_000_000);
  });

  it("returns the recorded directory as the resume locator and stops after Adapter close", async () => {
    const f = await fixture();
    expect(await f.importer.listCandidates()).toEqual({ ok: true, value: [] });
    const sessionDir = await f.save("s-a");
    const adapter = new KimiAdapter({ environment: f.environment });
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toEqual({
      ok: true,
      value: {
        candidate: expect.objectContaining({ nativeSessionId: "s-a", cwd: f.cwd }),
        nativeRef: {
          harnessId: "kimi-code",
          nativeSessionId: "s-a",
          locator: { cwd: f.cwd },
          formatVersion: 1,
        },
      },
    });
    await rm(sessionDir, { recursive: true });
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
