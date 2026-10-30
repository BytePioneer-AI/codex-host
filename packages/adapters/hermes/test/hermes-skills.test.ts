import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHermesSkillsCatalog, hermesSkillsRoots } from "../src/hermes-skills.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdir(path.join(os.tmpdir(), `hermes-skills-test-${Date.now()}`), {
    recursive: true,
  }).then(() => "");
  const dir = path.join(
    os.tmpdir(),
    `hermes-skills-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(path.join(dir, ".hermes"), { recursive: true });
  roots.push(dir);
  return dir;
}

describe("hermes skills roots", () => {
  it("composes the default root as ~/.hermes/skills, never ~/skills", () => {
    const env = { HOME: "/home/demo" };
    expect(hermesSkillsRoots(env)[0]?.directory).toBe("/home/demo/.hermes/skills");
    const override = hermesSkillsRoots({ HOME: "/home/demo", HERMES_HOME: "/custom/hermes" });
    expect(override[0]?.directory).toBe("/custom/hermes/skills");
  });

  it("marks the shared root read-only", () => {
    const rootsForEnv = hermesSkillsRoots({ HOME: "/home/demo" });
    expect(rootsForEnv.at(-1)?.readOnly).toBe(true);
  });
});

describe("hermes skill removal guard rails", () => {
  it("refuses removal when the essential list cannot be confirmed", async () => {
    const home = await temporaryHome();
    const environment = { HOME: home, HERMES_HOME: path.join(home, ".hermes") };
    // No venv inside the temp home: hermesAgentPython() finds nothing, so the essential
    // list is UNAVAILABLE — removal must be refused, never treated as "nothing protected".
    const skillsRoot = path.join(home, ".hermes", "skills", "creative");
    const skillDir = path.join(skillsRoot, "victim");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: victim\ndescription: removable-looking\n---\n",
    );
    const catalog = createHermesSkillsCatalog(environment);
    const result = await catalog.uninstall?.(
      { name: "victim", path: skillDir },
      AbortSignal.timeout(5000),
    );
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain("essential");
    await expect(readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain("victim");
  });
});

describe("hermes archive restore", () => {
  it("restores through a single legal category segment and refuses escape attempts", async () => {
    const home = await temporaryHome();
    const environment = { HOME: home, HERMES_HOME: path.join(home, ".hermes") };
    const skillsRoot = path.join(home, ".hermes", "skills");
    for (const [name, category] of [
      ["good-skill", "creative"],
      ["escape-skill", "creative/../../../outside"],
      ["dot-skill", ".archive"],
    ] as const) {
      const dir = path.join(skillsRoot, ".archive", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: parked\ncategory: ${category}\n---\n`,
      );
    }
    const catalog = createHermesSkillsCatalog(environment);
    const signal = AbortSignal.timeout(5000);

    // A legal single-segment category restores into it.
    const good = await catalog.setEnabled?.(
      { name: "good-skill", path: path.join(skillsRoot, ".archive", "good-skill") },
      true,
      signal,
    );
    expect(good?.ok).toBe(true);
    await expect(
      readFile(path.join(skillsRoot, "creative", "good-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("good-skill");

    // Path separators in the declared category are ignored (not honored): the restore falls
    // back to the root level and NOTHING lands outside the skills root.
    const escape = await catalog.setEnabled?.(
      { name: "escape-skill", path: path.join(skillsRoot, ".archive", "escape-skill") },
      true,
      signal,
    );
    expect(escape?.ok).toBe(true);
    await expect(
      readFile(path.join(skillsRoot, "escape-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("escape-skill");
    await expect(
      readFile(path.join(home, "outside", "escape-skill", "SKILL.md"), "utf8"),
    ).rejects.toThrow();

    const dot = await catalog.setEnabled?.(
      { name: "dot-skill", path: path.join(skillsRoot, ".archive", "dot-skill") },
      true,
      signal,
    );
    expect(dot?.ok).toBe(true); // falls back to the root level: single legal segment (none)
    await expect(
      readFile(path.join(skillsRoot, "dot-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("dot-skill");
  });
});
