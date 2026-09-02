import { describe, expect, it, vi } from "vitest";

import {
  closeNativeContextualSuggestions,
  completeHarnessMentionSelection,
  harnessMentionCandidates,
  harnessMentionLabel,
  harnessMentionMatch,
  injectNativeHarnessCommands,
  isNativeComposerCommandRegistry,
  matchingHarnessMentions,
  textWithHarnessMention,
  type NativeComposerCommand,
} from "../src/renderer-harness-mention-control.js";

describe("Renderer Harness mention completion", () => {
  it("closes the owning native contextual suggestions after selection", () => {
    const closeOwned = vi.fn();
    const closeSibling = vi.fn();
    const ownedSuggestions = {
      leadingItems: [],
      onAddContext: () => undefined,
      onRequestClose: closeOwned,
      onUpdateSelectedMention: () => undefined,
    };
    const siblingSuggestions = {
      ...ownedSuggestions,
      onRequestClose: closeSibling,
    };
    const owner = {
      memoizedProps: { contextualSuggestions: ownedSuggestions },
      sibling: { memoizedProps: { contextualSuggestions: siblingSuggestions } },
      return: null,
    };
    const editorFiber = { return: owner };

    expect(closeNativeContextualSuggestions(editorFiber)).toBe(1);
    expect(closeOwned).toHaveBeenCalledOnce();
    expect(closeSibling).not.toHaveBeenCalled();
  });

  it("inserts a Codex Account mention only after activation succeeds", async () => {
    const activation = Promise.withResolvers<boolean>();
    const insert = vi.fn();
    const close = vi.fn();
    const candidate = harnessMentionCandidates(
      ["codex"],
      [
        {
          accountId: "reviewer",
          label: "Reviewer",
          codexHome: "/tmp/reviewer",
          active: false,
          isDefault: false,
        },
      ],
    )[0];
    if (!candidate) throw new Error("Codex Account candidate is missing");

    completeHarnessMentionSelection(candidate, () => activation.promise, insert, close);
    expect(close).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
    activation.resolve(false);
    await activation.promise;
    await Promise.resolve();
    expect(insert).not.toHaveBeenCalled();

    completeHarnessMentionSelection(candidate, () => true, insert, close);
    await Promise.resolve();
    expect(insert).toHaveBeenCalledWith("@codex (Reviewer) ");
  });

  it("recognizes a Harness mention at the caret without matching email addresses", () => {
    expect(harnessMentionMatch("@cla")).toEqual({ query: "cla", start: 0, end: 4 });
    expect(harnessMentionMatch("让@pi")).toEqual({ query: "pi", start: 1, end: 4 });
    expect(harnessMentionMatch("review @omp")).toEqual({ query: "omp", start: 7, end: 11 });
    expect(harnessMentionMatch("mail foo@example")).toBeNull();
    expect(harnessMentionMatch("@pi later")).toBeNull();
  });

  it("filters the configured Harness candidates by prefix", () => {
    const agents = ["codex", "pi", "claude-code", "deepseek-harness", "grok", "omp"] as const;
    expect(matchingHarnessMentions("delegate @", agents)).toEqual(agents);
    expect(matchingHarnessMentions("delegate @cl", agents)).toEqual(["claude-code"]);
    expect(matchingHarnessMentions("delegate @deep", agents)).toEqual(["deepseek-harness"]);
    expect(matchingHarnessMentions("delegate @unknown", agents)).toEqual([]);
  });

  it("identifies native Codex delegation with the active Account label", () => {
    expect(harnessMentionLabel("codex", "Work Account")).toBe("Codex · Work Account");
    expect(harnessMentionLabel("claude-code", "Work Account")).toBe("Claude Code");
  });

  it("offers each inactive Codex Account and excludes the current Account", () => {
    const candidates = harnessMentionCandidates(
      ["codex", "claude-code"],
      [
        {
          accountId: "current",
          label: "Current",
          codexHome: "/tmp/current",
          active: true,
          isDefault: true,
        },
        {
          accountId: "reviewer",
          label: "Reviewer",
          email: "reviewer@example.com",
          codexHome: "/tmp/reviewer",
          active: false,
          isDefault: false,
        },
      ],
    );

    expect(candidates).toEqual([
      {
        accountId: "reviewer",
        agent: "codex",
        description: "@codex",
        id: "codexhost-harness-codex-reviewer",
        insertion: "@codex (reviewer@example.com) ",
        title: "Codex · reviewer@example.com",
      },
      {
        agent: "claude-code",
        description: "@claude-code",
        id: "codexhost-harness-claude-code",
        insertion: "@claude-code ",
        title: "Claude Code",
      },
    ]);
  });

  it("inserts the selected Harness after the native menu clears its query", () => {
    expect(textWithHarnessMention("Please delegate ", 16, 16, "@claude-code ")).toEqual({
      caret: 29,
      value: "Please delegate @claude-code ",
    });
  });

  it("recognizes the persistent native Composer command registry", () => {
    expect(
      isNativeComposerCommandRegistry([
        {
          id: "status",
          title: "Status",
          description: "Show status",
          requiresEmptyComposer: false,
          onSelect: () => undefined,
        },
      ]),
    ).toBe(true);
    expect(isNativeComposerCommandRegistry([{ id: "status" }])).toBe(false);
  });

  it("injects @ commands into the native registry without replacing its source reference", () => {
    const native = {
      id: "status",
      title: "Status",
      description: "Show status",
      requiresEmptyComposer: false,
      onSelect: () => undefined,
    };
    const stale = {
      id: "codexhost-harness-pi",
      title: "Pi",
      description: "@pi",
      requiresEmptyComposer: false,
      triggers: ["@"],
      onSelect: () => undefined,
    };
    const registry: NativeComposerCommand[] = [native, stale];
    const original = registry;
    injectNativeHarnessCommands(registry, [
      {
        id: "codexhost-harness-claude-code",
        title: "Claude Code",
        description: "@claude-code",
        requiresEmptyComposer: false,
        triggers: ["@"],
        onSelect: () => undefined,
      },
    ]);
    expect(registry).toBe(original);
    expect(registry.map((command) => command.id)).toEqual([
      "status",
      "codexhost-harness-claude-code",
    ]);
    expect(registry[1]?.triggers).toEqual(["@"]);
  });
});
