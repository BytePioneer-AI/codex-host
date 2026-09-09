import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEXHOST_DELEGATION_SKILL,
  PREVIOUS_MANAGED_DIGESTS,
  installDelegationSkills,
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

  it("uses existing Threads directly and keeps viewing requests read-only", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("For a new delegation, create an independent");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("operate on that Thread\ndirectly");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("is ambiguous, ask the user to identify it");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("session read-only");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("explicitly read the target Thread");
    expect(CODEXHOST_DELEGATION_SKILL).toContain(
      "omit unavailable fields rather than inventing them",
    );
  });

  it("routes natural agent requests and points execution to the authoritative help", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("version: 6");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("@agent) to independently perform a task");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("session's content, progress, or results");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("Not for recapping the current conversation");
    expect(CODEXHOST_DELEGATION_SKILL).toContain('"$CODEXHOST_CLI_PATH" delegate --help');
    expect(CODEXHOST_DELEGATION_SKILL).toContain("sole authoritative source");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("send a follow-up message");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("cancel its current Turn");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("target keeps its default");
    expect(CODEXHOST_DELEGATION_SKILL).not.toContain("--timeout-ms");
  });

  it("directs the CLI invocation through the Host-provided absolute path", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("CODEXHOST_CLI_PATH");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("Do not run a bare");
    expect(CODEXHOST_DELEGATION_SKILL).not.toMatch(/(^|[^"])`codexhost /mu);
  });

  it("gives a runnable bootstrap example for every supported shell", () => {
    // A POSIX-only example is not executable on Windows, where PowerShell needs
    // the `&` call operator and `$env:` scoping, and cmd needs `%VAR%`.
    expect(CODEXHOST_DELEGATION_SKILL).toContain('"$CODEXHOST_CLI_PATH" delegate --help');
    expect(CODEXHOST_DELEGATION_SKILL).toContain("& $env:CODEXHOST_CLI_PATH delegate --help");
    expect(CODEXHOST_DELEGATION_SKILL).toContain('"%CODEXHOST_CLI_PATH%" delegate --help');
  });

  it("keeps every previously shipped digest recognized as a managed copy", async () => {
    const { createHash } = await import("node:crypto");
    // v4 shipped in 0.6.0; its digest was previously absent, which pinned those
    // installations to a stale Skill because updates were reported as conflicts.
    expect(PREVIOUS_MANAGED_DIGESTS).toContain(
      "fa7944cd1e72ffbaf932fca2074bdb78aad4670d8990b6711220dd83c39509a0",
    );
    expect(PREVIOUS_MANAGED_DIGESTS).not.toContain(
      createHash("sha256").update(CODEXHOST_DELEGATION_SKILL).digest("hex"),
    );
    expect(new Set(PREVIOUS_MANAGED_DIGESTS).size).toBe(PREVIOUS_MANAGED_DIGESTS.length);
  });
});
