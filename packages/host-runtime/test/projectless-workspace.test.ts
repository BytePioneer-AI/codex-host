import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MappingStore, storedThreadCoreV1Schema } from "@codexhost/mapping-store";
import { clientWorkspaceSnapshotSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { HostClientChannel } from "@codexhost/desktop-control";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { allocateProjectlessWorkspace } from "../src/projectless-workspace.js";
import { readExternalWorkspaceSnapshot } from "../src/native-workspace-snapshot.js";
import { closeFixture, createFixture, stopFixture } from "./app-server-host-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function homeDirectory() {
  const home = await mkdtemp(path.join(tmpdir(), "ch-projectless-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

describe("owner-allocated projectless execution directories", () => {
  it("matches date/slug/ordinal layout and keeps cwd at the session root", async () => {
    const home = await homeDirectory();
    const environment = { HOME: home, USERPROFILE: home };
    const options = { now: new Date(2026, 9, 10, 12) };
    const first = await allocateProjectlessWorkspace(
      environment,
      "Review the API / add focused tests safely!",
      options,
    );
    expect(first).toEqual({
      workspaceRoot: path.join(home, "Documents", "Codex"),
      cwd: path.join(home, "Documents", "Codex", "2026-10-10", "review-the-api-add-focused-tests"),
      outputDirectory: path.join(
        home,
        "Documents",
        "Codex",
        "2026-10-10",
        "review-the-api-add-focused-tests",
        "outputs",
      ),
    });
    expect(await readdir(first.cwd)).toEqual(["outputs", "work"]);
    const second = await allocateProjectlessWorkspace(
      environment,
      "Review the API / add focused tests safely!",
      options,
    );
    expect(second.cwd).toBe(first.cwd + "-2");
    const fallback = await allocateProjectlessWorkspace(environment, "你好 / ../../", options);
    expect(path.basename(fallback.cwd)).toBe("new-chat");
  });

  it("allocates independent paths concurrently without overwriting an existing entry", async () => {
    const home = await homeDirectory();
    const environment = { HOME: home, USERPROFILE: home };
    const workspaces = await Promise.all(
      Array.from({ length: 8 }, () => allocateProjectlessWorkspace(environment, "Same task")),
    );
    expect(new Set(workspaces.map((workspace) => workspace.cwd)).size).toBe(8);
    const first = workspaces[0];
    if (!first) throw new Error("Missing allocated workspace");
    const marker = path.join(first.cwd, "keep.txt");
    await writeFile(marker, "existing user file");
    await allocateProjectlessWorkspace(environment, "Same task");
    expect(await readFile(marker, "utf8")).toBe("existing user file");
  });

  it("rejects a non-directory root, and symlink roots where supported", async () => {
    const home = await homeDirectory();
    const root = path.join(home, "file");
    await writeFile(root, "not a directory");
    await expect(allocateProjectlessWorkspace({}, "task", { root })).rejects.toThrow();
    if (process.platform !== "win32") {
      const alias = path.join(home, "alias");
      await symlink(home, alias, "dir");
      await expect(allocateProjectlessWorkspace({}, "task", { root: alias })).rejects.toThrow(
        "real directory",
      );
    }
  });

  it("keeps no-project affiliation in the canonical store across reload, not GUI metadata", async () => {
    const home = await homeDirectory();
    const codexHome = path.join(home, ".codex");
    await mkdir(codexHome);
    const nativeFile = path.join(codexHome, ".codex-global-state.json");
    const native = JSON.stringify({
      "project-order": ["parent-project"],
      "local-projects": {
        "parent-project": { id: "parent-project", name: "Parent", rootPaths: [home] },
      },
      "thread-project-assignments": {},
      "projectless-thread-ids": [],
    });
    await writeFile(nativeFile, native);
    const environment = { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
    const fixture = createFixture({ environment, mappingStoreDirectory: path.join(home, "store") });
    cleanup.push(() => stopFixture(fixture));
    await fixture.ready;
    const open = vi.spyOn(fixture.adapter, "open");
    const results = await Promise.all(
      [1, 2].map(() =>
        fixture.host.handleClientRequest("thread/start", {
          model: "codexhost/pi-native",
          projectlessWorkspace: { prompt: "Independent task" },
        }),
      ),
    );
    const threads = results.map((result) => {
      if (!("result" in result)) throw new Error(result.error.message);
      return (
        result.result as {
          thread: { id: string; cwd: string; projectId: null; workspaceKind: string };
        }
      ).thread;
    });
    expect(threads[0]?.cwd).not.toBe(threads[1]?.cwd);
    for (const thread of threads) {
      expect(thread).toMatchObject({ workspaceKind: "projectless", projectId: null });
      expect(path.basename(thread.cwd)).toMatch(/^independent-task(?:-2)?$/u);
      expect(await readdir(thread.cwd)).toEqual(["outputs", "work"]);
    }
    expect(open.mock.calls.map(([input]) => input.cwd)).toEqual(
      expect.arrayContaining(threads.map((thread) => thread.cwd)),
    );
    for (const thread of threads) {
      expect(
        await fixture.host.handleClientRequest("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: "First accepted task" }],
        }),
      ).toHaveProperty("result");
    }
    for (const session of fixture.adapter.sessions) session.succeedTurn();
    const workspaceReply = await fixture.host.handleClientRequest("codexhost/workspace/read", {});
    if (!("result" in workspaceReply)) throw new Error(workspaceReply.error.message);
    expect(clientWorkspaceSnapshotSchema.parse(workspaceReply.result)).toMatchObject({
      assignments: {},
      projectless: expect.arrayContaining(threads.map((thread) => thread.id)),
    });
    expect(await readFile(nativeFile, "utf8")).toBe(native);
    await closeFixture(fixture);
    const store = new MappingStore({ directory: path.join(home, "store") });
    cleanup.push(() => store.close());
    await store.initialize();
    const records = await store.listThreads();
    expect(records).toHaveLength(2);
    expect((await readExternalWorkspaceSnapshot(environment, records)).projectless.sort()).toEqual(
      threads.map((thread) => thread.id).sort(),
    );
    for (const record of records) {
      expect(record.projectId).toBeUndefined();
      expect(record.projectlessWorkspace?.outputDirectory).toBe(path.join(record.cwd, "outputs"));
      const core = JSON.parse(
        await readFile(path.join(home, "store", "threads", `${record.hostThreadId}.json`), "utf8"),
      );
      expect(storedThreadCoreV1Schema.safeParse(core).success).toBe(true);
    }
    const id = hostThreadIdSchema.parse(threads[0]?.id);
    await store.updateMetadata(id, { projectId: "parent-project" });
    const assigned = await readExternalWorkspaceSnapshot(environment, await store.listThreads());
    expect(assigned.assignments[id]).toBe("parent-project");
    expect(assigned.projectless).not.toContain(id);
    expect(await readFile(nativeFile, "utf8")).toBe(native);
  });

  it("projects the same no-project Thread to two authenticated clients without a second Adapter", async () => {
    const home = await homeDirectory();
    const fixture = createFixture({
      environment: { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") },
    });
    cleanup.push(() => stopFixture(fixture));
    await fixture.ready;
    const server = await startClientChannelServer({
      target: fixture.host,
      environment: {},
      directory: path.join(home, "control"),
    });
    cleanup.push(() => server.close());
    const a = new HostClientChannel(path.join(home, "control"), server.descriptor);
    const b = new HostClientChannel(path.join(home, "control"), server.descriptor);
    cleanup.push(() => {
      a.close();
      b.close();
    });
    await Promise.all([a.start(), b.start()]);
    const result = (await a.request("thread/start", {
      model: "codexhost/pi-native",
      projectlessWorkspace: { prompt: "Shared task" },
    })) as { thread: { id: string; cwd: string } };
    const first = clientWorkspaceSnapshotSchema.parse(
      await a.request("codexhost/workspace/read", {}),
    );
    const second = clientWorkspaceSnapshotSchema.parse(
      await b.request("codexhost/workspace/read", {}),
    );
    expect(first.projectless).toEqual([result.thread.id]);
    expect(second).toEqual(first);
    expect(first.projects).toEqual([]);
    expect(first.assignments).toEqual({});
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(path.dirname(result.thread.cwd)).toContain(path.join(home, "Documents", "Codex"));
  });

  it("rejects ambiguous or malformed choices before creating any directory or Session", async () => {
    const home = await homeDirectory();
    const fixture = createFixture({
      environment: { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") },
    });
    cleanup.push(() => stopFixture(fixture));
    await fixture.ready;
    for (const params of [
      { cwd: home, projectlessWorkspace: {} },
      { projectlessWorkspace: true },
      { projectlessWorkspace: { prompt: "task", cwd: home } },
      { projectlessWorkspace: {}, ephemeral: true },
    ])
      expect(
        await fixture.host.handleClientRequest("thread/start", {
          model: "codexhost/pi-native",
          ...params,
        }),
      ).toMatchObject({ error: { code: -32602 } });
    expect(await readdir(home)).toEqual([]);
    expect(fixture.adapter.sessions).toHaveLength(0);
  });
});
