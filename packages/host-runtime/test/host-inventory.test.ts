import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostInventory } from "../src/host-inventory.js";
import { repositoryRemote } from "../src/project-inventory.js";

describe("Host inventory", () => {
  let directory: string;
  let repos: string;
  let environment: NodeJS.ProcessEnv;
  let inventory: HostInventory;

  function git(cwd: string, args: string[]) {
    return execFileSync("git", ["-C", cwd, ...args], { env: environment, encoding: "utf8" });
  }

  async function repository(name: string, root = repos): Promise<string> {
    const cwd = path.join(root, name);
    await mkdir(cwd, { recursive: true });
    git(cwd, ["init", "-q", "--initial-branch=main"]);
    return cwd;
  }

  async function settings(value: Record<string, unknown>) {
    await writeFile(path.join(directory, "host-inventory.json"), JSON.stringify(value));
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-inventory-")));
    repos = path.join(directory, "Developer", "Repos");
    await mkdir(repos, { recursive: true });
    environment = {
      ...process.env,
      HOME: directory,
      CODEXHOST_DATA_DIR: directory,
      GIT_CONFIG_GLOBAL: path.join(directory, "no-global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    inventory = new HostInventory(environment);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("reports configured identity and an existing workspace without exposing environment secrets", async () => {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    await settings({ id: "air", name: "MacAir", aliases: ["work"], defaultWorkspace: workspace });
    const host = new HostInventory({ ...environment, PATH: "", PRIVATE_API_KEY: "do-not-expose" });
    const info = await host.info();
    expect(info).toMatchObject({
      id: "air",
      name: "MacAir",
      aliases: ["work"],
      defaultWorkspace: workspace,
      platform: process.platform,
      arch: process.arch,
      tools: expect.arrayContaining([
        expect.objectContaining({ command: "node", available: true }),
      ]),
    });
    expect(JSON.stringify(info)).not.toContain("do-not-expose");
    await settings({ defaultWorkspace: path.join(directory, "missing") });
    expect(await host.info()).not.toHaveProperty("defaultWorkspace");
  });

  it("discovers current repository facts, strips credentials and ignores dependency and symlink trees", async () => {
    const project = await repository("Personal/web-app");
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        description: "Small web application",
        dependencies: { react: "1", vite: "1" },
      }),
    );
    git(project, [
      "remote",
      "add",
      "origin",
      "https://user:secret@example.com/team/app.git?token=hidden#private",
    ]);
    await repository("node_modules/ignored");
    await repository(".hidden/ignored");
    const outside = await repository("outside", path.join(directory, "elsewhere"));
    await symlink(path.dirname(outside), path.join(repos, "linked"), "junction");
    const result = await inventory.projects();
    expect(result).toMatchObject({
      total: 1,
      nextOffset: null,
      truncated: false,
      unavailableRoots: [],
    });
    expect(result.projects).toEqual([
      expect.objectContaining({
        name: "web-app",
        cwd: project,
        branch: "main",
        remote: "https://example.com/team/app.git",
        description: "Small web application",
        technologies: ["node", "react", "vite"],
        manifests: ["package.json"],
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|hidden#|token=/u);
    expect((await inventory.projects({ query: "REACT" })).total).toBe(1);
    expect((await inventory.projects({ query: "unrelated" })).total).toBe(0);
  });

  it("discovers worktree branches without running Git clean filters or project scripts", async () => {
    const main = await repository("Personal/app");
    await writeFile(path.join(main, "tracked.txt"), "initial\n");
    await writeFile(path.join(main, ".gitattributes"), "tracked.txt filter=inventory-test\n");
    git(main, ["add", "."]);
    git(main, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(directory, "no-hooks")}`,
      "commit",
      "-qm",
      "fixture",
    ]);
    const worktree = path.join(repos, "Personal", "app.worktrees", "feature");
    git(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
    const marker = path.join(directory, "filter-executed");
    const filter = path.join(directory, "filter.cjs");
    await writeFile(
      filter,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.stdin.pipe(process.stdout);`,
    );
    git(main, ["config", "filter.inventory-test.clean", `node "${filter}"`]);
    await writeFile(path.join(main, "tracked.txt"), "changed\n");
    const result = await inventory.projects();
    expect(result.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: main, branch: "main" }),
        expect.objectContaining({ cwd: worktree, branch: "feature" }),
      ]),
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes project discovery on demand and immediately uses changed roots", async () => {
    const first = await repository("first");
    expect((await inventory.projects()).projects.map((p) => p.cwd)).toEqual([first]);
    await repository("second");
    expect((await inventory.projects()).total).toBe(1);
    expect((await inventory.projects({ refresh: true })).total).toBe(2);
    const other = path.join(directory, "other");
    const third = await repository("third", other);
    await settings({
      id: "configured-device",
      projectRoots: [other, path.join(directory, "missing")],
    });
    expect(await inventory.projects()).toMatchObject({
      deviceId: "configured-device",
      total: 1,
      projects: [expect.objectContaining({ cwd: third })],
      unavailableRoots: [path.join(directory, "missing")],
    });
  });

  it("paginates results and reports bounds rather than implying a complete unlimited scan", async () => {
    await repository("a");
    await repository("b");
    await repository("c");
    const first = await inventory.projects({ limit: 2 });
    expect(first).toMatchObject({ total: 3, nextOffset: 2 });
    expect(
      (await inventory.projects({ offset: first.nextOffset, limit: 2 })).projects.map(
        (p) => p.name,
      ),
    ).toEqual(["c"]);
    await repository("one/two/three/four/too-deep");
    const bounded = await inventory.projects({ refresh: true });
    expect(bounded.projects.some((p) => p.name === "too-deep")).toBe(false);
    expect(bounded.truncated).toBe(true);
  });

  it("automatically discovers new projects after the cache expires", async () => {
    await repository("first");
    expect((await inventory.projects()).total).toBe(1);
    await repository("second");
    expect((await inventory.projects()).total).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await inventory.projects()).total).toBe(2);
  });

  it("rejects invalid settings and request arguments before scanning", async () => {
    for (const args of [
      { refresh: "yes" },
      { offset: -1 },
      { limit: 101 },
      { limit: 0 },
      { query: 42 },
    ])
      await expect(inventory.projects(args)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(inventory.info({ refresh: "yes" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await settings({ projectRoots: ["relative"] });
    await expect(inventory.projects()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await writeFile(path.join(directory, "host-inventory.json"), "not json");
    await expect(inventory.projects()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it.each([
    [
      "ssh://user:secret@example.com/org/repo.git?private=value#token",
      "ssh://example.com/org/repo.git",
    ],
    ["git@example.com:org/repo.git", "example.com:org/repo.git"],
    ["file:///private/repo", undefined],
    ["/private/repo", undefined],
    ["C:\\private\\repo", undefined],
  ])("normalizes repository origin %s", (value, expected) => {
    expect(repositoryRemote(value)).toBe(expected);
  });
});
