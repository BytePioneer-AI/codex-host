import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEXHOST_DELEGATION_SKILL,
  inspectDelegationSkills,
  installDelegationSkills,
  uninstallDelegationSkills,
} from "../src/delegation-skill.js";

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
    const previous = (
      await readFile(new URL("./fixtures/delegation-skill-v3.md", import.meta.url), "utf8")
    ).replace(/\n$/, "");
    const destinations = paths(root);
    for (const destination of destinations) {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(destination), { recursive: true }),
      );
      await writeFile(destination, previous, "utf8");
    }
    const results = await installDelegationSkills({
      homeDirectory: root,
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

  it("reports missing, current, legacy, and conflict without changing files", async () => {
    const root = await home();
    expect(await inspectDelegationSkills({ homeDirectory: root })).toMatchObject([
      { status: "missing", version: null, digest: null },
      { status: "missing", version: null, digest: null },
    ]);
    await installDelegationSkills({ homeDirectory: root });
    const destinations = paths(root);
    const legacy = (
      await readFile(new URL("./fixtures/delegation-skill-v3.md", import.meta.url), "utf8")
    ).replace(/\n$/, "");
    await writeFile(destinations[0] ?? "", legacy, "utf8");
    await writeFile(destinations[1] ?? "", "user content\n", "utf8");
    const before = await Promise.all(
      destinations.map(async (file) => ({
        content: await readFile(file, "utf8"),
        mtimeMs: (await stat(file)).mtimeMs,
      })),
    );
    const statuses = await inspectDelegationSkills({
      homeDirectory: root,
    });
    expect(statuses).toMatchObject([
      {
        status: "managed-legacy",
        version: 3,
        digest: "15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d",
      },
      { status: "conflict" },
    ]);
    const after = await Promise.all(
      destinations.map(async (file) => ({
        content: await readFile(file, "utf8"),
        mtimeMs: (await stat(file)).mtimeMs,
      })),
    );
    expect(after).toEqual(before);
  });

  it("removes only managed copies and preserves conflicts", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const destinations = paths(root);
    await writeFile(destinations[0] ?? "", "user content\n", "utf8");
    const results = await uninstallDelegationSkills({ homeDirectory: root });
    expect(results.map(({ status }) => status)).toEqual(["conflict", "removed"]);
    await expect(readFile(destinations[0] ?? "", "utf8")).resolves.toBe("user content\n");
    await expect(stat(destinations[1] ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked ancestors and Skill entries", async () => {
    const root = await home();
    const outside = await home();
    await symlink(outside, path.join(root, ".agents"));
    await expect(inspectDelegationSkills({ homeDirectory: root })).rejects.toThrow(
      "Unsafe Skill directory",
    );

    const safeRoot = await home();
    const [entry] = paths(safeRoot);
    if (!entry) throw new Error("Missing Skill destination");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(entry), { recursive: true }),
    );
    await symlink(path.join(outside, "foreign.md"), entry);
    await expect(uninstallDelegationSkills({ homeDirectory: safeRoot })).rejects.toThrow(
      "Unsafe Skill entry",
    );
  });
});
