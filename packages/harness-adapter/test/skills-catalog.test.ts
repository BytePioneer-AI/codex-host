import { rm, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
});

describe("shared skills directory", () => {
  it("derives from HOME", () => {
    expect(harnessSharedSkillsDirectory({ HOME: "/home/demo" })).toBe("/home/demo/.agents/skills");
    expect(harnessSharedSkillsDirectory({})).toBeUndefined();
  });
});
