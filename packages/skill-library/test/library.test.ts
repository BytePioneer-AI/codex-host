import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillLibrary, SKILL_LIBRARY_LIMITS as limits } from "../src/index.js";
import { scanRoot } from "../src/scan.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

let home: string;
const libraries: SkillLibrary[] = [];
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "skill-library-")));
});
afterEach(async () => {
  for (const library of libraries.splice(0)) library.dispose();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});
function library() {
  const value = new SkillLibrary({ home, codexHome: join(home, ".codex") });
  libraries.push(value);
  return value;
}
async function skill(directory: string, name = "review", extra = "") {
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await fs.writeFile(path, `---\nname: ${name}\ndescription: Explain changes\n---\n${extra}`);
  return path;
}
async function refresh(value: SkillLibrary, cwd?: string) {
  const change = vi.fn();
  const off = value.subscribe(change);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + limits.freshMs + 1);
  await value.list({ cwd });
  // A stale read returns its old snapshot; wait for the published replacement.
  await vi.waitFor(() => expect(change).toHaveBeenCalled());
  off();
  return value.list({ cwd });
}

describe("Skill Library", () => {
  it("includes all global sources without a workspace or installed plugins", async () => {
    await skill(join(home, ".pi/agent/skills/review"));
    const result = await library().list();
    expect(result.complete).toBe(true);
    expect(result.skills).toMatchObject([{ name: "review", source: "Pi", scope: "global" }]);
  });

  it("walks only cwd to the nearest Git file boundary, or cwd alone without Git", async () => {
    const repo = join(home, "repo");
    const cwd = join(repo, "app");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(join(repo, ".git"), "gitdir: test");
    await skill(join(repo, ".agents/skills/root"), "root");
    await skill(join(cwd, ".dsh/skills/local"), "local");
    await skill(join(home, ".dsh/skills/elsewhere"), "elsewhere");
    const value = library();
    expect((await value.list({ cwd })).skills.map((s) => s.name)).toEqual(["local", "root"]);
    await fs.rm(join(repo, ".git"));
    expect((await library().list({ cwd })).skills.map((s) => s.name)).toEqual(["local"]);
  });

  it("finds nested skills, stops below a skill, and bounds depth and ignored directories", async () => {
    const root = join(home, ".agents/skills");
    await skill(join(root, "group/review"));
    await skill(join(root, "group/review/hidden"), "below-skill");
    await skill(join(root, ".hidden/skip"), "hidden");
    await skill(join(root, "node_modules/skip"), "dependency");
    await skill(join(root, ...Array<string>(limits.depth).fill("a")), "at-limit");
    await skill(join(root, ...Array<string>(limits.depth).fill("b"), "too-deep"), "too-deep");
    expect((await library().list()).skills.map((s) => s.name)).toEqual(["at-limit", "review"]);
  });

  it("follows symbolic directories without loops and deduplicates real file paths", async () => {
    const directory = join(home, ".agents/skills/review");
    const path = await skill(directory);
    await fs.mkdir(join(home, ".claude/skills"), { recursive: true });
    await fs.symlink(directory, join(home, ".claude/skills/alias"), "junction");
    await fs.symlink(join(home, ".agents/skills"), join(home, ".agents/skills/loop"), "junction");
    expect((await library().list()).skills).toMatchObject([{ path }]);
    expect((await library().list()).skills).toHaveLength(1);
  });

  it("warns for missing/invalid names, malformed YAML and oversized frontmatter", async () => {
    const root = join(home, ".agents/skills");
    for (const [directory, frontmatter] of Object.entries({
      missing: "description: missing",
      space: "name: bad name",
      brackets: "name: '[bad]'",
      malformed: "name: [",
      oversized: `name: large\ndescription: ${"x".repeat(limits.frontmatterBytes)}`,
    })) {
      await fs.mkdir(join(root, directory), { recursive: true });
      await fs.writeFile(join(root, directory, "SKILL.md"), `---\n${frontmatter}\n---\n`);
    }
    await skill(join(root, "valid"));
    const result = await library().list();
    expect(result.skills).toHaveLength(1);
    expect(result.warnings).toHaveLength(5);
  });

  it("re-lists existing empty subdirectories and probes their newly created SKILL.md", async () => {
    const directory = join(home, ".agents/skills/new");
    await fs.mkdir(directory, { recursive: true });
    const value = library();
    const before = await value.list();
    await skill(directory);
    const result = await refresh(value);
    expect(result.skills).toHaveLength(1);
    expect(result.revision).toBeGreaterThan(before.revision);
    await fs.rm(join(directory, "SKILL.md"));
    expect((await refresh(value)).skills).toHaveLength(0);
  });

  it("retains same-name files with project first and distinguishable sources", async () => {
    await skill(join(home, ".agents/skills/review"));
    const cwd = join(home, "repo");
    await skill(join(cwd, ".pi/skills/review"));
    const result = await library().list({ cwd });
    expect(result.skills.map((s) => [s.name, s.scope, s.source])).toEqual([
      ["review", "project", "Pi"],
      ["review", "global", "Agents"],
    ]);
  });

  it("keeps old results on directory permissions failure and retries independently", async () => {
    const root = join(home, ".agents/skills");
    await skill(join(root, "known"));
    const value = library();
    await value.list();
    const original = fs.readdir;
    const readdir = vi
      .spyOn(fs, "readdir")
      .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
        if (args[0] === root)
          return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
        return original(...args);
      });
    await skill(join(home, ".claude/skills/other"), "other");
    const result = await refresh(value);
    expect(result.skills.map((s) => s.name)).toEqual(["other", "review"]);
    expect(result.warnings?.join()).toContain("permission denied");
    readdir.mockRestore();
    expect((await refresh(value)).warnings).toBeUndefined();
  });

  it("does no file reads while fresh, coalesces stale scans, and reuses unchanged metadata", async () => {
    await skill(join(home, ".agents/skills/review"));
    const value = library();
    await value.list();
    const reads = vi.spyOn(fs, "open");
    const lists = vi.spyOn(fs, "readdir");
    await value.list();
    await value.list();
    expect(lists).not.toHaveBeenCalled();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + limits.freshMs + 1);
    await Promise.all(Array.from({ length: 10 }, () => value.list()));
    await vi.waitFor(() => expect(lists).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 50));
    expect(lists.mock.calls.filter(([path]) => path === join(home, ".agents/skills"))).toHaveLength(
      1,
    );
    expect(reads).not.toHaveBeenCalled();
  });

  it("returns a partial snapshot within the first-scan deadline", async () => {
    await skill(join(home, ".agents/skills/ready"));
    const original = fs.readdir;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === join(home, ".claude/skills")) await gate;
      return original(...args);
    });
    await fs.mkdir(join(home, ".claude/skills"), { recursive: true });
    const value = library();
    const start = performance.now();
    const result = await value.list();
    expect(performance.now() - start).toBeLessThan(limits.firstScanWaitMs + 300);
    expect(result.complete).toBe(false);
    expect(result.skills).toHaveLength(1);
    release();
    await vi.waitFor(async () => expect((await value.list()).complete).toBe(true));
  });

  it("evicts LRU workspaces and fences late results from an evicted generation", async () => {
    const cwd = join(home, "repo");
    await skill(join(cwd, ".agents/skills/old"), "old");
    const original = fs.open;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let first = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).includes("/old/") && first) {
        first = false;
        await gate;
      }
      return handle;
    });
    const value = library();
    value.prepare(cwd);
    await vi.waitFor(() => expect(first).toBe(false));
    for (let i = 0; i < limits.workspaces; i++) value.prepare(join(home, `other-${i}`));
    await fs.rm(join(cwd, ".agents/skills/old"), { recursive: true });
    await skill(join(cwd, ".agents/skills/new"), "new");
    expect((await value.list({ cwd })).skills.map((s) => s.name)).toEqual(["new"]);
    release();
    await new Promise((done) => setTimeout(done, 50));
    expect((await value.list({ cwd })).skills.map((s) => s.name)).toEqual(["new"]);
  });

  it("measures full discovery and unchanged-file validation on 116 temporary skills", async () => {
    await Promise.all(
      Array.from({ length: 116 }, (_, i) =>
        skill(join(home, ".agents/skills", `skill-${i}`), `skill-${i}`),
      ),
    );
    const root = { path: join(home, ".agents/skills"), scope: "global" as const, source: "Agents" };
    const start = performance.now();
    const snapshot = await scanRoot(root);
    expect(snapshot.files.size).toBe(116);
    const scanned = performance.now();
    await scanRoot(root, snapshot);
    console.info(
      `Skill Library (116 temporary skills): initial ${(scanned - start).toFixed(1)} ms; validation ${(performance.now() - scanned).toFixed(1)} ms`,
    );
  });
});
