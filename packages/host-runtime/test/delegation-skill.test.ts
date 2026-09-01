import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEXHOST_DELEGATION_SKILL,
  createDelegationSkillLifecycleForTest,
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test path");
  return value;
}

async function artifacts(destination: string): Promise<string[]> {
  return (await readdir(path.dirname(destination))).filter((name) =>
    /^\.SKILL\.md\..+\.(?:journal|quarantine)$/u.test(name),
  );
}

async function directorySnapshot(destination: string): Promise<unknown> {
  const directory = path.dirname(destination);
  const directoryStat = await lstat(directory);
  return {
    directory: {
      ino: directoryStat.ino,
      mode: directoryStat.mode,
      mtimeMs: directoryStat.mtimeMs,
    },
    entries: await Promise.all(
      (await readdir(directory)).sort().map(async (name) => {
        const filePath = path.join(directory, name);
        const metadata = await lstat(filePath);
        return {
          name,
          ino: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
          content: metadata.isFile() ? (await readFile(filePath)).toString("base64") : null,
        };
      }),
    ),
  };
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
    await expect(stat(path.dirname(destinations[1] ?? ""))).resolves.toMatchObject({});
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

  it("rejects a home whose lexical and filesystem resolutions disagree", async () => {
    const root = await home();
    const safe = path.join(root, "safe");
    const outside = path.join(root, "outside");
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([mkdir(safe), mkdir(path.join(outside, "child"), { recursive: true })]),
    );
    await symlink(path.join(outside, "child"), path.join(safe, "link"));

    await expect(
      installDelegationSkills({ homeDirectory: `${safe}${path.sep}link${path.sep}..` }),
    ).rejects.toThrow("Ambiguous Skill home");
    await expect(stat(path.join(safe, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(outside, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe writable directories", async () => {
    const root = await home();
    await mkdir(path.join(root, ".agents"));
    await chmod(path.join(root, ".agents"), 0o777);

    await expect(installDelegationSkills({ homeDirectory: root })).rejects.toThrow(
      "Unsafe Skill directory",
    );
  });

  it("recovers the same uninstall transaction after faults without new quarantines", async () => {
    for (const faultEvent of ["afterJournal", "afterRename", "afterHash"] as const) {
      const root = await home();
      await installDelegationSkills({ homeDirectory: root });
      const destination = required(paths(await realpath(root))[0]);
      let failed = false;
      const lifecycle = createDelegationSkillLifecycleForTest({
        onEvent(event, paths_) {
          if (!failed && event === faultEvent && paths_.destination === destination) {
            failed = true;
            throw new Error(`fault:${faultEvent}`);
          }
        },
      });

      await expect(lifecycle.uninstall({ homeDirectory: root })).rejects.toThrow(
        `fault:${faultEvent}`,
      );
      await uninstallDelegationSkills({ homeDirectory: root });
      const afterRecovery = await artifacts(destination);
      await uninstallDelegationSkills({ homeDirectory: root });
      expect(await artifacts(destination)).toEqual(afterRecovery);
      expect(afterRecovery.filter((name) => name.endsWith(".quarantine"))).toHaveLength(1);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("classifies only the active destination without recovering pending transactions", async () => {
    for (const faultEvent of ["afterJournal", "afterRename", "afterHash"] as const) {
      const root = await home();
      await installDelegationSkills({ homeDirectory: root });
      const destination = required(paths(await realpath(root))[0]);
      let failed = false;
      const faultingLifecycle = createDelegationSkillLifecycleForTest({
        onEvent(event, paths_) {
          if (!failed && event === faultEvent && paths_.destination === destination) {
            failed = true;
            throw new Error(`fault:readonly-${faultEvent}`);
          }
        },
      });
      await expect(faultingLifecycle.uninstall({ homeDirectory: root })).rejects.toThrow(
        `fault:readonly-${faultEvent}`,
      );
      const before = await directorySnapshot(destination);
      const readOnlyLifecycle = createDelegationSkillLifecycleForTest({
        onEvent(event) {
          throw new Error(`status mutated transaction:${event}`);
        },
      });

      const statuses = await readOnlyLifecycle.inspect({ homeDirectory: root });

      expect(statuses[0]?.status).toBe(faultEvent === "afterJournal" ? "current" : "missing");
      expect(statuses[1]?.status).toBe("current");
      expect(await directorySnapshot(destination)).toEqual(before);
    }
  });

  it("restores a swapped conflict without clobbering an occupied destination", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const destination = required(paths(await realpath(root))[0]);
    let swapped = false;
    const lifecycle = createDelegationSkillLifecycleForTest({
      async onEvent(event, paths_) {
        if (swapped || event !== "afterHash" || paths_.destination !== destination) return;
        swapped = true;
        const quarantine = required(paths_.quarantine);
        await rename(quarantine, `${quarantine}.managed`);
        await writeFile(quarantine, "swapped user bytes\n", "utf8");
        await writeFile(destination, "new occupant\n", "utf8");
      },
    });

    await expect(lifecycle.uninstall({ homeDirectory: root })).rejects.toThrow(
      "destination is occupied",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("new occupant\n");
    const names = await readdir(path.dirname(destination));
    const quarantine = required(names.find((name) => name.endsWith(".quarantine")));
    await expect(readFile(path.join(path.dirname(destination), quarantine), "utf8")).resolves.toBe(
      "swapped user bytes\n",
    );
    await expect(
      readFile(path.join(path.dirname(destination), `${quarantine}.managed`), "utf8"),
    ).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
    expect(names.some((name) => name.endsWith(".journal"))).toBe(true);
  });

  it("restores a swapped conflict by no-clobber hard link when the destination is free", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const destination = required(paths(await realpath(root))[0]);
    let swapped = false;
    const lifecycle = createDelegationSkillLifecycleForTest({
      async onEvent(event, paths_) {
        if (swapped || event !== "afterHash" || paths_.destination !== destination) return;
        swapped = true;
        const quarantine = required(paths_.quarantine);
        await rename(quarantine, `${quarantine}.managed`);
        await writeFile(quarantine, "swapped user bytes\n", "utf8");
      },
    });

    await expect(lifecycle.uninstall({ homeDirectory: root })).rejects.toThrow(
      "transaction contains foreign content",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("swapped user bytes\n");
    expect((await artifacts(destination)).some((name) => name.endsWith(".journal"))).toBe(true);
  });

  it("recovers an interrupted legacy update before retrying installation", async () => {
    const root = await home();
    const destination = required(paths(await realpath(root))[0]);
    const previous = (
      await readFile(new URL("./fixtures/delegation-skill-v3.md", import.meta.url), "utf8")
    ).replace(/\n$/u, "");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, previous, "utf8");
    let failed = false;
    const lifecycle = createDelegationSkillLifecycleForTest({
      onEvent(event, paths_) {
        if (!failed && event === "afterRename" && paths_.destination === destination) {
          failed = true;
          throw new Error("fault:update-after-rename");
        }
      },
    });

    await expect(lifecycle.install({ homeDirectory: root })).rejects.toThrow(
      "fault:update-after-rename",
    );
    await installDelegationSkills({ homeDirectory: root });
    await expect(readFile(destination, "utf8")).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
    expect(
      (await artifacts(destination)).filter((name) => name.endsWith(".quarantine")),
    ).toHaveLength(1);
  });

  it("rejects a foreign uid through the private filesystem seam", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const destination = required(paths(await realpath(root))[0]);
    const lifecycle = createDelegationSkillLifecycleForTest({
      async lstat(filePath, fallback) {
        const metadata = await fallback();
        if (filePath !== destination) return metadata;
        return new Proxy(metadata, {
          get(target, property) {
            if (property === "uid") return target.uid + 1;
            return Reflect.get(target, property, target);
          },
        });
      },
      onEvent() {},
    });

    await expect(lifecycle.inspect({ homeDirectory: root })).rejects.toThrow("Unsafe Skill entry");
  });

  it("does not overwrite a file raced into a missing install destination", async () => {
    const root = await home();
    const destination = required(paths(await realpath(root))[0]);
    let raced = false;
    const lifecycle = createDelegationSkillLifecycleForTest({
      async onEvent(event, paths_) {
        if (raced || event !== "beforeCommit" || paths_.destination !== destination) return;
        raced = true;
        await writeFile(destination, "race winner\n", "utf8");
      },
    });

    await expect(lifecycle.install({ homeDirectory: root })).rejects.toThrow(
      "destination is occupied",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("race winner\n");
    expect((await artifacts(destination)).some((name) => name.endsWith(".journal"))).toBe(true);
  });

  it("fails closed when an ancestor is swapped immediately before or after commit", async () => {
    for (const swapEvent of ["beforeCommit", "afterCommit"] as const) {
      const root = await home();
      const canonicalRoot = await realpath(root);
      const destination = required(paths(canonicalRoot)[0]);
      const outside = await home();
      await mkdir(path.join(outside, "skills", "codexhost-delegation"), { recursive: true });
      const saved = path.join(canonicalRoot, `.agents.${swapEvent}.saved`);
      let swapped = false;
      const lifecycle = createDelegationSkillLifecycleForTest({
        async onEvent(event, paths_) {
          if (swapped || event !== swapEvent || paths_.destination !== destination) return;
          swapped = true;
          await rename(path.join(canonicalRoot, ".agents"), saved);
          await symlink(outside, path.join(canonicalRoot, ".agents"));
        },
      });

      await expect(lifecycle.install({ homeDirectory: root })).rejects.toThrow(
        "Unsafe Skill directory",
      );
      await expect(
        stat(path.join(outside, "skills", "codexhost-delegation", "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const savedFiles = await readdir(path.join(saved, "skills", "codexhost-delegation"));
      expect(savedFiles.some((name) => name.endsWith(".journal"))).toBe(true);
      if (swapEvent === "afterCommit") {
        await expect(
          readFile(path.join(saved, "skills", "codexhost-delegation", "SKILL.md"), "utf8"),
        ).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
      }
    }
  });

  it("rejects malformed transaction journals without touching active bytes", async () => {
    const root = await home();
    await installDelegationSkills({ homeDirectory: root });
    const destination = required(paths(await realpath(root))[0]);
    const journal = path.join(
      path.dirname(destination),
      ".SKILL.md.00000000-0000-4000-8000-000000000000.journal",
    );
    await writeFile(journal, "not json\n", "utf8");

    await expect(uninstallDelegationSkills({ homeDirectory: root })).rejects.toThrow(
      "Invalid Delegation Skill transaction journal",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe(CODEXHOST_DELEGATION_SKILL);
    await expect(readFile(journal, "utf8")).resolves.toBe("not json\n");
  });

  it("rejects a forged journal digest without quarantining foreign bytes", async () => {
    const root = await home();
    const destination = required(paths(await realpath(root))[0]);
    await mkdir(path.dirname(destination), { recursive: true });
    const content = "foreign bytes named by forged journal\n";
    await writeFile(destination, content, "utf8");
    const id = "00000000-0000-4000-8000-000000000001";
    const quarantine = path.join(path.dirname(destination), `.SKILL.md.${id}.quarantine`);
    const journal = path.join(path.dirname(destination), `.SKILL.md.${id}.journal`);
    await writeFile(
      journal,
      `${JSON.stringify({
        version: 1,
        id,
        operation: "uninstall",
        destination,
        quarantine,
        expectedDigest: createHash("sha256").update(content).digest("hex"),
      })}\n`,
      "utf8",
    );

    await expect(installDelegationSkills({ homeDirectory: root })).rejects.toThrow(
      "Invalid Delegation Skill transaction journal",
    );
    await expect(readFile(destination, "utf8")).resolves.toBe(content);
    await expect(stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
import { createHash } from "node:crypto";
