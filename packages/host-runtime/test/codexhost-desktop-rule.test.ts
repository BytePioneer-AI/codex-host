import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEXHOST_DESKTOP_RULE,
  installCodexhostDesktopRules,
} from "../src/codexhost-desktop-rule.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-desktop-rule-"));
}

function grokPath(root: string): string {
  return path.join(root, ".grok", "rules", "codexhost-desktop.md");
}

function claudePath(root: string): string {
  return path.join(root, ".claude", "rules", "codexhost-desktop.md");
}

describe("Codex Desktop rule installation", () => {
  it("installs only the Grok home rule", async () => {
    const root = await home();
    const results = await installCodexhostDesktopRules({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["installed"]);
    await expect(readFile(grokPath(root), "utf8")).resolves.toBe(CODEXHOST_DESKTOP_RULE);
    await expect(stat(claudePath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite a Grok copy already at the current version", async () => {
    const root = await home();
    await installCodexhostDesktopRules({ homeDirectory: root });
    const file = grokPath(root);
    const before = await stat(file);
    const results = await installCodexhostDesktopRules({ homeDirectory: root });
    const after = await stat(file);
    expect(results.map((result) => result.status)).toEqual(["current"]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("updates a Grok copy whose digest matches a previous managed version", async () => {
    const root = await home();
    const previous = "<!-- codexhost-desktop-rule: 0 -->\nold\n";
    const destination = grokPath(root);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, previous, "utf8");
    const { createHash } = await import("node:crypto");
    const results = await installCodexhostDesktopRules({
      homeDirectory: root,
      previousManagedDigests: [createHash("sha256").update(previous).digest("hex")],
    });
    expect(results.map((result) => result.status)).toEqual(["updated"]);
    await expect(readFile(destination, "utf8")).resolves.toBe(CODEXHOST_DESKTOP_RULE);
  });

  it("preserves a user-modified Grok copy", async () => {
    const root = await home();
    const grok = grokPath(root);
    await mkdir(path.dirname(grok), { recursive: true });
    await writeFile(grok, "user content\n", "utf8");
    const results = await installCodexhostDesktopRules({ homeDirectory: root });
    expect(results.map((result) => result.status)).toEqual(["conflict"]);
    await expect(readFile(grok, "utf8")).resolves.toBe("user content\n");
  });

  it("removes a previously managed Claude copy and preserves a user-edited Claude copy", async () => {
    const root = await home();
    const claude = claudePath(root);
    await mkdir(path.dirname(claude), { recursive: true });
    const previous = "<!-- codexhost-desktop-rule: 2 -->\nold\n";
    await writeFile(claude, previous, "utf8");
    const { createHash } = await import("node:crypto");
    const removed = await installCodexhostDesktopRules({
      homeDirectory: root,
      previousManagedDigests: [createHash("sha256").update(previous).digest("hex")],
    });
    expect(removed.map((result) => result.status)).toEqual(["installed", "removed"]);
    await expect(stat(claude)).rejects.toMatchObject({ code: "ENOENT" });

    const other = await home();
    const otherClaude = claudePath(other);
    await mkdir(path.dirname(otherClaude), { recursive: true });
    await writeFile(otherClaude, "user claude rule\n", "utf8");
    const conflict = await installCodexhostDesktopRules({ homeDirectory: other });
    expect(conflict.map((result) => result.status)).toEqual(["installed", "conflict"]);
    await expect(readFile(otherClaude, "utf8")).resolves.toBe("user claude rule\n");
  });

  it("fail-closes on CODEXHOST_THREAD_ID without printing secrets", () => {
    expect(CODEXHOST_DESKTOP_RULE).toContain("codexhost-desktop-rule: 3");
    expect(CODEXHOST_DESKTOP_RULE).toContain("CODEXHOST_THREAD_ID");
    expect(CODEXHOST_DESKTOP_RULE).toContain("realtime-voice-chat");
    expect(CODEXHOST_DESKTOP_RULE).toContain("leave the session rules inactive");
    expect(CODEXHOST_DESKTOP_RULE).toContain("even when cwd is a real repository");
    expect(CODEXHOST_DESKTOP_RULE).toContain("Never print");
    expect(CODEXHOST_DESKTOP_RULE).toContain("CODEXHOST_RUNTIME_TOKEN");
    expect(CODEXHOST_DESKTOP_RULE).toContain("echo set");
    expect(CODEXHOST_DESKTOP_RULE).not.toContain("echo $CODEXHOST_THREAD_ID");
    expect(CODEXHOST_DESKTOP_RULE).not.toContain("OpenPets");
  });

  it("captures the Desktop session rules with Harness vs Model wording", () => {
    expect(CODEXHOST_DESKTOP_RULE).toContain("this Harness's Model");
    expect(CODEXHOST_DESKTOP_RULE).toContain("flash-max");
    expect(CODEXHOST_DESKTOP_RULE).toContain("Gemini Flash");
    expect(CODEXHOST_DESKTOP_RULE).toContain("grok-4.6");
    expect(CODEXHOST_DESKTOP_RULE).toContain("Playground");
    expect(CODEXHOST_DESKTOP_RULE).toContain("gpt-live");
    expect(CODEXHOST_DESKTOP_RULE).toContain("SkillWiki on Grok");
    expect(CODEXHOST_DESKTOP_RULE).toContain("Markdown View");
    expect(CODEXHOST_DESKTOP_RULE).toContain("thread/realtime/*");
    expect(CODEXHOST_DESKTOP_RULE).toContain("AGENT_TOOLS_AND_RULES.md");
  });
});
