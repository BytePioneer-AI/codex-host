import { createReadStream } from "node:fs";
import type * as NodeFs from "node:fs";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PiAdapter } from "../src/pi-adapter.js";
import {
  PiSessionImportIndex,
  listPiSessionImportSources,
  piSessionImportDirectory,
} from "../src/pi-session-import.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-pi-import-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessions);
  const environment = { PI_CODING_AGENT_SESSION_DIR: sessions };
  const entries = (id = "native-pi-session") => [
    { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Private prompt", timestamp: 1_767_225_600_000 },
    },
    {
      type: "session_info",
      id: "name-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      name: "Original title",
    },
  ];
  const save = async (
    values: unknown[] = entries(),
    file = path.join(sessions, "session.jsonl"),
  ) => {
    await writeFile(file, values.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return file;
  };
  const list = (signal = new AbortController().signal) =>
    listPiSessionImportSources(environment, signal);
  return { root, cwd, sessions, environment, entries, save, list };
}

describe("Pi native Session import discovery", () => {
  it("follows Pi's home, agent-dir and explicit flat session-dir precedence", () => {
    const home = path.resolve("synthetic-home");
    const env = { HOME: home, USERPROFILE: home };
    expect(piSessionImportDirectory(env)).toEqual({
      directory: path.join(home, ".pi", "agent", "sessions"),
      flat: false,
    });
    expect(piSessionImportDirectory({ ...env, PI_CODING_AGENT_DIR: "~/custom-agent" })).toEqual({
      directory: path.join(home, "custom-agent", "sessions"),
      flat: false,
    });
    expect(
      piSessionImportDirectory({
        ...env,
        PI_CODING_AGENT_DIR: "ignored",
        PI_CODING_AGENT_SESSION_DIR: "~/flat",
      }),
    ).toEqual({ directory: path.join(home, "flat"), flat: true });
  });

  it("discovers v3 metadata and a resumable native ref without touching the original file", async () => {
    const f = await fixture();
    const file = await f.save();
    const before = await readFile(file, "utf8");
    expect(await f.list()).toEqual([
      {
        candidate: {
          nativeSessionId: "native-pi-session",
          cwd: f.cwd,
          title: "Original title",
          updatedAt: 1_767_225_600_000,
          running: null,
        },
        nativeRef: {
          harnessId: "pi",
          nativeSessionId: "native-pi-session",
          locator: { sessionFile: file },
          formatVersion: 1,
        },
      },
    ]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it.each([
    ["string", "First prompt", "First prompt"],
    [
      "blocks",
      [
        { type: "image", data: "ignored" },
        { type: "text", text: "First" },
        { type: "text", text: "prompt" },
      ],
      "First prompt",
    ],
    ["image only", [{ type: "image", data: "ignored" }], null],
    ["long prompt", "x".repeat(5_000), "x".repeat(4_096)],
  ])(
    "uses the first user text as the unnamed session title: %s",
    async (_label, content, title) => {
      const f = await fixture();
      const entries = f.entries().slice(0, 2);
      await f.save([
        entries[0],
        { ...entries[1], message: { role: "user", content, timestamp: 1_767_225_600_000 } },
      ]);
      expect(await f.list()).toMatchObject([{ candidate: { title } }]);
    },
  );

  it("scans one project level by default, but only flat files with the explicit override", async () => {
    const f = await fixture();
    const project = path.join(f.sessions, "--encoded-project--");
    await mkdir(project);
    await f.save(f.entries("default-session"), path.join(project, "default.jsonl"));
    await f.save(f.entries("flat-session"));
    expect((await f.list()).map(({ candidate }) => candidate.nativeSessionId)).toEqual([
      "flat-session",
    ]);
    const result = await listPiSessionImportSources(
      { PI_CODING_AGENT_DIR: f.root },
      new AbortController().signal,
    );
    expect(result.map(({ candidate }) => candidate.nativeSessionId)).toEqual(["default-session"]);
  });

  it.each([
    "malformed",
    "old-format",
    "empty-id",
    "empty-entry-id",
    "relative-cwd",
    "missing-project",
    "no-user",
    "broken-parent",
    "duplicate-entry",
    "inactive-user-branch",
  ])("skips %s rather than mapping a session Pi cannot safely resume", async (kind) => {
    const f = await fixture();
    let entries: unknown[] = f.entries();
    const header = f.entries()[0];
    if (kind === "old-format") entries[0] = { ...header, version: 2 };
    if (kind === "empty-id") entries[0] = { ...header, id: "" };
    if (kind === "empty-entry-id") entries[1] = { ...f.entries()[1], id: "" };
    if (kind === "relative-cwd") entries[0] = { ...header, cwd: "relative" };
    if (kind === "missing-project") entries[0] = { ...header, cwd: path.join(f.root, "gone") };
    if (kind === "no-user") entries = [header];
    if (kind === "broken-parent") entries[1] = { ...f.entries()[1], parentId: "missing" };
    if (kind === "duplicate-entry") entries.push(f.entries()[1]);
    if (kind === "inactive-user-branch")
      entries.push({
        type: "custom",
        id: "new-leaf",
        parentId: null,
        customType: "unrelated",
        data: {},
      });
    const file = await f.save(entries);
    if (kind === "malformed") await writeFile(file, "{not-json}\n");
    expect(await f.list()).toEqual([]);
  });

  it("follows the final active branch and uses the latest native session name", async () => {
    const f = await fixture();
    await f.save([
      ...f.entries(),
      {
        type: "message",
        id: "user-2",
        parentId: "user-1",
        message: { role: "user", content: "New branch", timestamp: 1_767_225_602_000 },
      },
      { type: "session_info", id: "name-2", parentId: "user-2", name: "Renamed" },
    ]);
    expect(await f.list()).toMatchObject([
      { candidate: { title: "Renamed", updatedAt: 1_767_225_602_000 } },
    ]);
  });

  it("rejects duplicate session identities, including a new duplicate created after discovery", async () => {
    const f = await fixture();
    await f.save();
    const index = new PiSessionImportIndex(f.environment);
    const signal = new AbortController().signal;
    await index.list(signal);
    await f.save(f.entries(), path.join(f.sessions, "duplicate.jsonl"));
    await expect(index.resolve("native-pi-session", signal)).rejects.toThrow("ambiguous");
    await expect(index.list(signal)).rejects.toThrow("ambiguous");
  });

  it("streams valid Sessions larger than 64 MiB and total storage above 256 MiB without a size ceiling", async () => {
    const f = await fixture();
    // Valid JSONL whitespace, not a giant in-memory Transcript or a malformed sparse file.
    const padding = (" ".repeat(4095) + "\n").repeat(256);
    for (let index = 0; index < 4; index++) {
      const file = await f.save(
        f.entries(`large-${index}`),
        path.join(f.sessions, `${index}.jsonl`),
      );
      for (let chunk = 0; chunk < 65; chunk++) await appendFile(file, padding);
    }
    expect(await f.list()).toHaveLength(4);
  }, 20_000);

  it("indexes more than 1,000 candidates without confusing total storage with a wire page", async () => {
    const f = await fixture();
    for (let index = 0; index < 1_005; index++)
      await f.save(f.entries(`session-${index}`), path.join(f.sessions, `${index}.jsonl`));
    expect(await f.list()).toHaveLength(1_005);
  });

  it("accepts an active branch beyond the old Entry count ceiling", async () => {
    const f = await fixture();
    const file = await f.save();
    let parentId = "name-1";
    const entries: string[] = [];
    for (let index = 0; index < 100_001; index++) {
      const id = `entry-${index}`;
      entries.push(
        JSON.stringify({ type: "custom", customType: "test", id, parentId, data: null }),
      );
      parentId = id;
    }
    await appendFile(file, entries.join("\n") + "\n");
    expect(await f.list()).toHaveLength(1);
  });

  it("caches only metadata, notices edits/deletions and fully revalidates only the selected file on import", async () => {
    const f = await fixture();
    const selected = await f.save();
    const other = await f.save(f.entries("other-session"), path.join(f.sessions, "other.jsonl"));
    const index = new PiSessionImportIndex(f.environment);
    const signal = new AbortController().signal;
    const first = await index.list(signal);
    expect(createReadStream).toHaveBeenCalledTimes(2);
    if (first[0]) first[0].candidate.title = "Untrusted mutation";
    expect(await index.list(signal)).not.toEqual(first);
    expect(createReadStream).toHaveBeenCalledTimes(2);
    await f.save([
      ...f.entries(),
      { type: "session_info", id: "rename", parentId: "name-1", name: "New name" },
    ]);
    expect(await index.list(signal)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate: expect.objectContaining({ title: "New name" }) }),
      ]),
    );
    expect(createReadStream).toHaveBeenCalledTimes(3);
    await appendFile(other, "\n");
    vi.mocked(createReadStream).mockClear();
    expect(await index.resolve("native-pi-session", signal)).toMatchObject({
      candidate: { title: "New name" },
      nativeRef: { locator: { sessionFile: selected } },
    });
    const fullReads = vi
      .mocked(createReadStream)
      .mock.calls.filter(
        ([, options]) => typeof options === "object" && options !== null && "end" in options,
      );
    expect(fullReads.map(([file]) => file)).toEqual([selected]);
    await rm(selected);
    expect(await index.list(signal)).toMatchObject([
      { candidate: { nativeSessionId: "other-session" } },
    ]);
    expect(await index.resolve("native-pi-session", signal)).toBeNull();
  });

  it("returns empty only for missing roots, rejects unusable roots, and honors cancellation", async () => {
    const f = await fixture();
    await rm(f.sessions, { recursive: true });
    expect(await f.list()).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(f.list(abort.signal)).rejects.toThrow();
    await writeFile(f.sessions, "not a directory");
    await expect(f.list()).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "does not follow file or directory symlinks",
    async () => {
      const f = await fixture();
      const target = await f.save(f.entries(), path.join(f.root, "outside.jsonl"));
      await symlink(target, path.join(f.sessions, "linked.jsonl"));
      expect(await f.list()).toEqual([]);
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      await f.save(f.entries(), path.join(outside, "session.jsonl"));
      await symlink(outside, path.join(f.sessions, "project-link"));
      expect(
        await listPiSessionImportSources(
          { PI_CODING_AGENT_DIR: f.root },
          new AbortController().signal,
        ),
      ).toEqual([]);
    },
  );

  it("cancels and drains discovery when the Adapter closes", async () => {
    const f = await fixture();
    await f.save();
    const createTransport = vi.fn(() => {
      throw new Error("Unexpected spawn");
    });
    const adapter = new PiAdapter({ environment: f.environment }, { createTransport });
    const pending = adapter.sessionImport.listCandidates();
    await adapter.close();
    expect(await pending).toMatchObject({ ok: false });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("exposes browser-only metadata, revalidates on resolve, and closes without spawning Pi", async () => {
    const f = await fixture();
    const file = await f.save();
    const createTransport = vi.fn(() => {
      throw new Error("Discovery must not launch Pi");
    });
    const adapter = new PiAdapter({ environment: f.environment }, { createTransport });
    const list = await adapter.sessionImport.listCandidates();
    expect(list).toMatchObject({
      ok: true,
      value: [{ running: null, nativeSessionId: "native-pi-session" }],
    });
    expect(JSON.stringify(list)).not.toContain("sessionFile");
    expect(JSON.stringify(list)).not.toContain("Private prompt");
    await f.save([
      ...f.entries(),
      { type: "session_info", id: "rename", parentId: "name-1", name: "Fresh title" },
    ]);
    expect(await adapter.sessionImport.resolveCandidate("native-pi-session")).toMatchObject({
      ok: true,
      value: { candidate: { title: "Fresh title" }, nativeRef: { locator: { sessionFile: file } } },
    });
    await rm(file);
    expect(await adapter.sessionImport.resolveCandidate("native-pi-session")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(createTransport).not.toHaveBeenCalled();
  });
});
