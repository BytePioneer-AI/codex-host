import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { retireCodexhostDesktopRules } from "../src/codexhost-desktop-rule.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-desktop-rule-"));
}

function grokPath(root: string): string {
  return path.join(root, ".grok", "rules", "codexhost-desktop.md");
}

function claudePath(root: string): string {
  return path.join(root, ".claude", "rules", "codexhost-desktop.md");
}

describe("Codex Desktop home-rule retirement", () => {
  it("reports absent when no copies exist and does not create them", async () => {
    const root = await home();
    const results = await retireCodexhostDesktopRules({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["absent", "absent"]);
    await expect(stat(grokPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(claudePath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the shipped Grok home-rule copy and a managed Claude leftover", async () => {
    const root = await home();
    const shipped = await readFile(new URL("./fixtures/codexhost-desktop-v3.md", import.meta.url), {
      encoding: "utf8",
    });
    await mkdir(path.dirname(grokPath(root)), { recursive: true });
    await mkdir(path.dirname(claudePath(root)), { recursive: true });
    await writeFile(grokPath(root), shipped);
    await writeFile(claudePath(root), shipped);
    const results = await retireCodexhostDesktopRules({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["removed", "removed"]);
    await expect(stat(grokPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(claudePath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a previous managed digest supplied for the upgrade case", async () => {
    const root = await home();
    const previous = "<!-- codexhost-desktop-rule: 0 -->\nold\n";
    await mkdir(path.dirname(grokPath(root)), { recursive: true });
    await writeFile(grokPath(root), previous);
    const { createHash } = await import("node:crypto");
    const results = await retireCodexhostDesktopRules({
      homeDirectory: root,
      previousManagedDigests: [createHash("sha256").update(previous).digest("hex")],
    });
    expect(results.map((result) => result.status)).toEqual(["removed", "absent"]);
    await expect(stat(grokPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a user-edited copy", async () => {
    const root = await home();
    await mkdir(path.dirname(grokPath(root)), { recursive: true });
    await writeFile(grokPath(root), "user content\n");
    const results = await retireCodexhostDesktopRules({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["conflict", "absent"]);
    await expect(readFile(grokPath(root), "utf8")).resolves.toBe("user content\n");
  });
});
