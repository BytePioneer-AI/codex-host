import { describe, expect, it } from "vitest";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";

import {
  claudeDynamicCommandPrompt,
  claudeLiveCommandCatalog,
  parseClaudeSlashCommands,
} from "../src/slash-commands.js";

const builtIns = harnessCommandCatalogSchema.parse({
  commands: [
    { id: "claude.compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
  ],
});

describe("Claude live command catalog", () => {
  const commands = parseClaudeSlashCommands([
    { name: "compact", description: "native compact", argumentHint: "" },
    { name: "review", description: "Review a PR", argumentHint: "<pr>" },
    { name: "frontend-design:frontend-design", description: "Design UI", argumentHint: "" },
    { name: "", description: "ignored" },
    "not-an-object",
  ]);

  it("keeps built-ins and appends live commands and skills", () => {
    const catalog = claudeLiveCommandCatalog(builtIns, {
      commands,
      skillNames: new Set(["frontend-design:frontend-design"]),
    });
    expect(catalog.commands.map(({ invocation, kind }) => [invocation, kind])).toEqual([
      ["/compact", undefined],
      ["/review", "command"],
      ["/frontend-design:frontend-design", "skill"],
    ]);
    expect(catalog.commands.slice(1).every(({ argumentMode }) => argumentMode === "text")).toBe(
      true,
    );
  });

  it("uses built-ins alone before the native Session starts", () => {
    expect(claudeLiveCommandCatalog(builtIns, null)).toBe(builtIns);
  });

  it("builds prompt text only for dynamic commands", () => {
    const catalog = claudeLiveCommandCatalog(builtIns, { commands, skillNames: new Set() });
    expect(claudeDynamicCommandPrompt(catalog, "claude.slash.review", " 42 ")).toBe("/review 42");
    expect(claudeDynamicCommandPrompt(catalog, "claude.slash.review", undefined)).toBe("/review");
    expect(claudeDynamicCommandPrompt(catalog, "claude.compact", "x")).toBeNull();
    expect(claudeDynamicCommandPrompt(catalog, "claude.slash.missing", undefined)).toBeNull();
  });
});
