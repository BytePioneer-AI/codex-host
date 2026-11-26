import { describe, expect, it } from "vitest";
import { buildHarnessMenuLayout } from "../src/client/harness-menu.ts";

describe("buildHarnessMenuLayout", () => {
  it("groups ready, error, and uninstalled Harnesses into Desktop-matching Main and More sections", () => {
    const layout = buildHarnessMenuLayout({
      harnesses: [
        { id: "codex", name: "Codex", models: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
        { id: "claude-code", name: "Claude Code", models: [{ id: "opus", name: "Opus" }] },
        { id: "pi", name: "Pi", models: [{ id: "pi-1", name: "Pi 1" }] },
      ],
      failures: [{ id: "cursor-cli", name: "Cursor CLI", message: "Auth error" }],
      notInstalled: [
        { id: "codebuddy", name: "CodeBuddy", installUrl: "https://example.com/codebuddy" },
        { id: "devin", name: "Devin" },
      ],
      harnessOrder: ["codex", "claude-code", "cursor-cli", "pi", "codebuddy", "devin"],
      moreHarnesses: ["pi", "codebuddy", "devin"],
      boundHarnessId: null,
      boundHandoffEnabled: false,
    });

    expect(layout.boundEntry).toBeUndefined();
    expect(layout.main.map((entry) => [entry.id, entry.kind])).toEqual([
      ["codex", "ready"],
      ["claude-code", "ready"],
      ["cursor-cli", "error"],
    ]);
    expect(layout.more.map((entry) => [entry.id, entry.kind])).toEqual([
      ["pi", "ready"],
      ["codebuddy", "notInstalled"],
      ["devin", "notInstalled"],
    ]);
    expect(layout.showSameHarnessHandoff).toBe(false);
    expect(layout.showHideUnusedCta).toBe(false);
  });

  it("pins the bound Harness at the top and keeps Main/More partitioning for handoff targets", () => {
    const layout = buildHarnessMenuLayout({
      harnesses: [
        { id: "codex", name: "Codex", models: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
        { id: "antigravity", name: "Antigravity CLI", models: [{ id: "neon", name: "Neon" }] },
      ],
      failures: [],
      notInstalled: [{ id: "devin", name: "Devin" }],
      harnessOrder: ["codex", "antigravity", "devin"],
      moreHarnesses: ["devin"],
      boundHarnessId: "antigravity",
      boundHandoffEnabled: true,
    });

    expect(layout.boundEntry?.id).toBe("antigravity");
    expect(layout.main.map((entry) => entry.id)).toEqual(["codex"]);
    expect(layout.more.map((entry) => [entry.id, entry.kind])).toEqual([["devin", "notInstalled"]]);
    expect(layout.showSameHarnessHandoff).toBe(false);
  });

  it("offers same-Harness handoff when only the bound Harness is ready while keeping uninstalled entries in More", () => {
    const layout = buildHarnessMenuLayout({
      harnesses: [
        { id: "antigravity", name: "Antigravity CLI", models: [{ id: "neon", name: "Neon" }] },
      ],
      failures: [],
      notInstalled: [{ id: "codebuddy", name: "CodeBuddy" }],
      harnessOrder: ["antigravity", "codebuddy"],
      moreHarnesses: ["codebuddy"],
      boundHarnessId: "antigravity",
      boundHandoffEnabled: true,
    });

    expect(layout.boundEntry?.id).toBe("antigravity");
    expect(layout.main).toEqual([]);
    expect(layout.showSameHarnessHandoff).toBe(true);
    expect(layout.more.map((entry) => entry.id)).toEqual(["codebuddy"]);
  });

  it("shows the hide-unused CTA when there are more than 5 Harnesses and none are folded into More", () => {
    const layout = buildHarnessMenuLayout({
      harnesses: ["codex", "claude-code", "pi", "grok", "antigravity", "qwen-code"].map((id) => ({
        id,
        name: id,
        models: [{ id: "m1", name: "M1" }],
      })),
      failures: [],
      notInstalled: [],
      moreHarnesses: [],
      boundHarnessId: null,
      boundHandoffEnabled: false,
    });

    expect(layout.showHideUnusedCta).toBe(true);
  });
});
