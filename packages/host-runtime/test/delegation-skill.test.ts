import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CODEXHOST_DELEGATION_SKILL, installDelegationSkills } from "../src/delegation-skill.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-skill-test-"));
}

function paths(root: string): string[] {
  return [
    path.join(root, ".agents", "skills", "codexhost-delegation", "SKILL.md"),
    path.join(root, ".claude", "skills", "codexhost-delegation", "SKILL.md"),
  ];
}

describe("delegation Skill installation", () => {
  it("atomically installs identical managed copies", async () => {
    const root = await home();
    const results = await installDelegationSkills({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["installed", "installed"]);
    const [agents, claude] = await Promise.all(paths(root).map((file) => readFile(file, "utf8")));
    expect(agents).toBe(CODEXHOST_DELEGATION_SKILL);
    expect(claude).toBe(agents);
  });

  it("does not rewrite copies already at the current version", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const file = paths(root)[0];
    if (!file) throw new Error("Missing Skill destination");
    const before = await stat(file);
    const results = await installDelegationSkills({ homeDirectory: root });
    const after = await stat(file);
    expect(results.map((result) => result.status)).toEqual(["current", "current"]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("updates copies whose digest matches a previous managed version", async () => {
    const root = await home();
    const previous = "---\nname: codexhost-delegation\nversion: 0\n---\nold\n";
    const destinations = paths(root);
    for (const destination of destinations) {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(destination), { recursive: true }),
      );
      await writeFile(destination, previous, "utf8");
    }
    const { createHash } = await import("node:crypto");
    const results = await installDelegationSkills({
      homeDirectory: root,
      previousManagedDigests: [createHash("sha256").update(previous).digest("hex")],
    });
    expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
    await expect(readFile(destinations[0] ?? "", "utf8")).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
  });

  it("preserves a user-modified copy while independently installing the other destination", async () => {
    const root = await home();
    const [agents] = paths(root);
    if (!agents) throw new Error("Missing Agent Skill destination");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(agents), { recursive: true }),
    );
    await writeFile(agents, "user content\n", "utf8");
    const results = await installDelegationSkills({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["conflict", "installed"]);
    await expect(readFile(agents, "utf8")).resolves.toBe("user content\n");
  });

  it("routes natural agent requests and points execution to the authoritative help", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("version: 4");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("Claude Code, Pi, Codex/OpenAI, OMP, Grok");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("codexhost delegate --help");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("sole authoritative source");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("send a follow-up message");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("cancel its current Turn");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("target keeps its default");
    expect(CODEXHOST_DELEGATION_SKILL).not.toContain("--timeout-ms");
  });
});
