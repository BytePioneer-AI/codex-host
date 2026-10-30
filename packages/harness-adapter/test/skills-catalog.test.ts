import { rm, mkdtemp, mkdir, readFile, writeFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  harnessSkillFromDirectory,
  harnessSkillFrontmatter,
  harnessSharedSkillsDirectory,
  readDirectories,
  scanHarnessSkillsRoot,
} from "../src/skills-catalog.js";
import { createHarnessSkillsCatalog } from "../src/skills-catalog-helper.js";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "codexhost-skills-"));
}

async function removeTree(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

const readdir = (directory: string) => readDirectories(directory);
const readFileText = (file: string) => readFile(file, "utf8");

describe("skill manifest parsing", () => {
  it("reads the frontmatter subset the manifests use", () => {
    const fields = harnessSkillFrontmatter(
      '---\nname: demo\ndescription: "quoted, colon: inside"\ncategory: devops\n---\n\n# Body',
    );
    expect(fields).toEqual({
      name: "demo",
      description: "quoted, colon: inside",
      category: "devops",
    });
    expect(harnessSkillFrontmatter("no fence at all")).toBeUndefined();
    expect(harnessSkillFrontmatter("---\nnever closed: true")).toBeUndefined();
  });

  it("needs a name and a description", () => {
    const skill = harnessSkillFromDirectory(
      "/root",
      "/root/demo",
      "---\nname: demo\ndescription: does things\n---\n",
    );
    expect(skill?.name).toBe("demo");
    expect(skill?.description).toBe("does things");
    expect(skill?.category).toBeUndefined();
    expect(
      harnessSkillFromDirectory("/root", "/root/broken", "---\nname: broken\n---\n"),
    ).toBeUndefined();
  });

  it("reads the frontmatter of a manifest whose body runs past the parse window", () => {
    const root = "/home/demo/skills";
    const body = "x".repeat(200 * 1024);
    const skill = harnessSkillFromDirectory(
      root,
      path.join(root, "big-skill"),
      `---\nname: big-skill\ndescription: survives a long body\n---\n\n${body}\n`,
    );
    expect(skill?.name).toBe("big-skill");
    expect(skill?.description).toBe("survives a long body");
  });

  it("takes the category from frontmatter, else the category directory, else nothing", () => {
    expect(
      harnessSkillFromDirectory(
        "/root",
        "/root/demo",
        "---\nname: d\ndescription: x\ncategory: tools\n---\n",
      )?.category,
    ).toBe("tools");
    expect(
      harnessSkillFromDirectory("/root", "/root/devops/demo", "---\nname: d\ndescription: x\n---\n")
        ?.category,
    ).toBe("devops");
    expect(
      harnessSkillFromDirectory("/root", "/root/demo", "---\nname: d\ndescription: x\n---\n")
        ?.category,
    ).toBeUndefined();
  });
});

describe("scanHarnessSkillsRoot", () => {
  it("reads nested and flat skills and reports broken manifests", async () => {
    const root = await temporaryRoot();
    try {
      await mkdir(path.join(root, "devops/nested-skill"), { recursive: true });
      await writeFile(
        path.join(root, "devops/nested-skill/SKILL.md"),
        "---\nname: nested\ndescription: in a category\n---\n",
      );
      await mkdir(path.join(root, "flat-skill"));
      await writeFile(
        path.join(root, "flat-skill/SKILL.md"),
        "---\ndescription: name comes from the directory\n---\n",
      );
      await mkdir(path.join(root, "broken-skill"));
      await writeFile(path.join(root, "broken-skill/SKILL.md"), "---\nname: only\n---\n");
      await mkdir(path.join(root, "plain-directory"));
      await writeFile(path.join(root, "ignored-file.txt"), "not a directory");

      const scan = await scanHarnessSkillsRoot(
        root,
        { readdir, readFile: readFileText },
        AbortSignal.timeout(5000),
      );
      expect(scan.skills.map((skill) => skill.name).sort()).toEqual(["flat-skill", "nested"]);
      expect(scan.skills.find((skill) => skill.name === "nested")?.category).toBe("devops");
      expect(scan.skills.find((skill) => skill.name === "flat-skill")?.category).toBeUndefined();
      expect(scan.failures).toHaveLength(1);
      expect(scan.failures[0]?.path).toBe(path.join(root, "broken-skill"));
    } finally {
      await removeTree(root);
    }
  });

  it("does not descend into a directory that already has a manifest", async () => {
    const root = await temporaryRoot();
    try {
      await mkdir(path.join(root, "outer/inner"), { recursive: true });
      await writeFile(
        path.join(root, "outer/SKILL.md"),
        "---\nname: outer\ndescription: wins\n---\n",
      );
      await writeFile(
        path.join(root, "outer/inner/SKILL.md"),
        "---\nname: inner\ndescription: never listed\n---\n",
      );
      const scan = await scanHarnessSkillsRoot(
        root,
        { readdir, readFile: readFileText },
        AbortSignal.timeout(5000),
      );
      expect(scan.skills.map((skill) => skill.name)).toEqual(["outer"]);
      expect(scan.failures).toEqual([]);
    } finally {
      await removeTree(root);
    }
  });
  it("marks skills inside a hidden directory as archived", async () => {
    const root = await temporaryRoot();
    try {
      await mkdir(path.join(root, ".archive/retired"), { recursive: true });
      await mkdir(path.join(root, "live"), { recursive: true });
      await writeFile(
        path.join(root, ".archive/retired/SKILL.md"),
        "---\nname: retired\ndescription: parked\n---\n",
      );
      await writeFile(
        path.join(root, "live/SKILL.md"),
        "---\nname: live\ndescription: loaded\n---\n",
      );
      const scan = await scanHarnessSkillsRoot(
        root,
        { readdir, readFile: readFileText },
        AbortSignal.timeout(5000),
      );
      const byName = new Map(scan.skills.map((skill) => [skill.name, skill]));
      expect(byName.get("retired")?.archived).toBe(true);
      expect(byName.get("live")?.archived).toBeUndefined();
    } finally {
      await removeTree(root);
    }
  });
});

describe("skill removal guard rails", () => {
  it("removes a real skill directory and refuses everything else", async () => {
    const root = await temporaryRoot();
    try {
      const live = path.join(root, "creative", "temp-skill");
      const archived = path.join(root, ".archive", "old-skill");
      const nested = path.join(root, "a", "b", "c");
      const notASkill = path.join(root, "creative", "not-a-skill");
      for (const directory of [live, archived, nested, notASkill]) {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(
        path.join(live, "SKILL.md"),
        "---\nname: temp-skill\ndescription: removable\n---\n",
      );
      await writeFile(
        path.join(archived, "SKILL.md"),
        "---\nname: old-skill\ndescription: parked\n---\n",
      );
      await writeFile(
        path.join(nested, "SKILL.md"),
        "---\nname: deep-skill\ndescription: buried\n---\n",
      );

      const catalog = createHarnessSkillsCatalog({
        environment: {},
        roots: () => [{ directory: root }],
        label: "Test",
      });
      const signal = AbortSignal.timeout(5000);

      // Refs carry the confirmed path; the backend re-checks it against a fresh scan.
      expect((await catalog.uninstall?.({ name: "temp-skill", path: live }, signal))?.ok).toBe(
        true,
      );
      await expect(access(live)).rejects.toThrow();

      const hidden = await catalog.uninstall?.({ name: "old-skill", path: archived }, signal);
      expect(hidden?.ok).toBe(false);
      expect(hidden?.reason).toContain("hidden");

      const tooDeep = await catalog.uninstall?.({ name: "deep-skill", path: nested }, signal);
      expect(tooDeep?.ok).toBe(false);
      expect(tooDeep?.reason).toContain("nested too deep");

      expect((await catalog.uninstall?.({ name: "missing-skill" }, signal))?.ok).toBe(false);
      // A plain directory that holds no SKILL.md is not a skill the catalog may remove.
      expect(
        (await catalog.uninstall?.({ name: "not-a-skill", path: notASkill }, signal))?.ok,
      ).toBe(false);
      // A path the fresh scan no longer agrees with is refused, never resolved by name alone.
      const moved = await catalog.uninstall?.(
        { name: "temp-skill", path: path.join(root, "creative", "elsewhere") },
        signal,
      );
      expect(moved?.ok).toBe(false);
      // The scan finds no such skill at that path anymore (it was removed above): the refusal
      // proves the confirmed path gates the lookup instead of falling back to the name.
      expect(moved?.reason ?? "").toMatch(/no longer lives at|No skill named/);
    } finally {
      await removeTree(root);
    }
  });

  it("refuses same-name ambiguity and read-only roots", async () => {
    const own = await temporaryRoot();
    const shared = await temporaryRoot();
    try {
      const left = path.join(own, "creative", "dupe");
      const right = path.join(own, "devops", "dupe");
      const sharedSkill = path.join(shared, "shared-demo");
      for (const directory of [left, right, sharedSkill]) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${path.basename(directory)}\ndescription: same name\n---\n`,
        );
      }
      await writeFile(
        path.join(right, "SKILL.md"),
        "---\nname: dupe\ndescription: other category\n---\n",
      );

      const catalog = createHarnessSkillsCatalog({
        environment: {},
        roots: () => [
          { directory: own },
          { directory: shared, categoryFallback: "shared", readOnly: true },
        ],
        label: "Test",
      });
      const signal = AbortSignal.timeout(5000);

      // Two same-name skills and no confirmed path: the backend never guesses.
      const ambiguous = await catalog.uninstall?.({ name: "dupe" }, signal);
      expect(ambiguous?.ok).toBe(false);
      expect(ambiguous?.reason).toContain("ambiguous");

      // The confirmed path picks the exact one even among same-name siblings.
      expect((await catalog.uninstall?.({ name: "dupe", path: left }, signal))?.ok).toBe(true);
      await expect(access(left)).rejects.toThrow();
      await expect(access(right)).resolves.toBeUndefined();

      // A read-only shared root is refused by the backend whatever its declared category.
      const sharedRefusal = await catalog.uninstall?.(
        { name: "shared-demo", path: sharedSkill },
        signal,
      );
      expect(sharedRefusal?.ok).toBe(false);
      expect(sharedRefusal?.reason).toContain("read-only");
      await expect(access(sharedSkill)).resolves.toBeUndefined();
    } finally {
      await removeTree(own);
      await removeTree(shared);
    }
  });
});

describe("shared skills directory", () => {
  it("derives from HOME", () => {
    expect(harnessSharedSkillsDirectory({ HOME: "/home/demo" })).toBe("/home/demo/.agents/skills");
    expect(harnessSharedSkillsDirectory({})).toBeUndefined();
  });
});

describe("frontmatter block scalars", () => {
  it("folds > and | descriptions instead of showing the marker", () => {
    const fields = harnessSkillFrontmatter(
      "---\nname: blocks\ndescription: >-\n  line one\n  line two\nother: |\n  a\n  b\n---\n",
    );
    expect(fields?.description).toBe("line one line two");
    expect(fields?.other).toBe("a\nb");
  });
});

describe("readDirectories follows directory symlinks", () => {
  it("lists symlinked skill directories and skips dangling links", async () => {
    const root = await temporaryRoot();
    try {
      const real = path.join(root, "real-skill");
      await mkdir(real, { recursive: true });
      await symlink(real, path.join(root, "linked-skill"));
      await symlink(path.join(root, "missing"), path.join(root, "dangling"));
      const names = await readDirectories(root);
      expect(names).toContain("linked-skill");
      expect(names).toContain("real-skill");
      expect(names).not.toContain("dangling");
    } finally {
      await removeTree(root);
    }
  });
});
