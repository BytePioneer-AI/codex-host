import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

  it.each([
    ["v4 Skill shipped in v0.4.0-v0.6.0", "codexhost-delegation-v4.md"],
    ["v8 Skill that ran codexhost from PATH", "codexhost-delegation-v8.md"],
  ])("updates the %s", async (_name, fixture) => {
    const root = await home();
    const shipped = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8");
    const destinations = paths(root);
    for (const destination of destinations) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, shipped, "utf8");
    }
    const results = await installDelegationSkills({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
    for (const destination of destinations) {
      await expect(readFile(destination, "utf8")).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
    }
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
  });

  it("routes natural agent requests and points execution to the authoritative help", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("version: 10");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("@agent) to independently perform a task");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("session's content, progress, or results");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("Not for recapping the current conversation");
    expect(CODEXHOST_DELEGATION_SKILL).toContain('"$CODEXHOST_CLI_PATH" delegate --help');
    expect(CODEXHOST_DELEGATION_SKILL).toContain("& $env:CODEXHOST_CLI_PATH delegate --help");
    expect(CODEXHOST_DELEGATION_SKILL).toContain('"%CODEXHOST_CLI_PATH%" delegate --help');
    expect(CODEXHOST_DELEGATION_SKILL).toContain("If CODEXHOST_CLI_PATH is unset, try");
    expect(CODEXHOST_DELEGATION_SKILL).not.toContain("CODEXHOST_CLI_NODE_PATH");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("send a follow-up message");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("cancel its current Turn");
    expect(CODEXHOST_DELEGATION_SKILL).not.toContain("--timeout-ms");
  });

  it("teaches the pending-Question read, answer, and re-watch workflow", () => {
    expect(CODEXHOST_DELEGATION_SKILL).toContain("pendingQuestions");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("thread answer <thread> --interaction <id>");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("--answers-file <file>");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("An invalid answer changes nothing");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("needsInput");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("alreadyNeedsInput");
    expect(CODEXHOST_DELEGATION_SKILL).toContain("outside the task authorization");
  });
});
