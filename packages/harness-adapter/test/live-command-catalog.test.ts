import { describe, expect, it } from "vitest";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";

import {
  isExcludedLiveCommand,
  LiveHarnessCommandCatalog,
  liveHarnessCommandPrompt,
  mergeLiveHarnessCommands,
} from "../src/index.js";

const builtIns = harnessCommandCatalogSchema.parse({
  commands: [{ id: "x.compact", invocation: "/compact", label: "Compact", argumentMode: "text" }],
});

describe("live Harness command catalog", () => {
  it("keeps built-ins, appends namespaced text commands and drops duplicates", () => {
    const catalog = mergeLiveHarnessCommands(builtIns, "x.slash.", [
      { name: "compact", kind: "command" },
      { name: "/review", description: " Review ", kind: "command" },
      { name: "review", kind: "command" },
      { name: "skill:tdd", kind: "skill" },
      { name: "a b", kind: "command" },
      { name: "  ", kind: "command" },
    ]);
    expect(catalog.commands).toEqual([
      builtIns.commands[0],
      {
        id: "x.slash.review",
        invocation: "/review",
        label: "review",
        description: "Review",
        argumentMode: "text",
        kind: "command",
      },
      {
        id: "x.slash.skill:tdd",
        invocation: "/skill:tdd",
        label: "skill:tdd",
        argumentMode: "text",
        kind: "skill",
      },
    ]);
    expect(mergeLiveHarnessCommands(builtIns, "x.slash.", null)).toBe(builtIns);
  });

  it("builds prompt text only for live ids", () => {
    const live = new LiveHarnessCommandCatalog({ idPrefix: "x.slash.", builtIns });
    live.update([{ name: "review", kind: "command" }]);
    expect(live.promptFor("x.slash.review", " 42 ")).toBe("/review 42");
    expect(live.promptFor("x.slash.review", undefined)).toBe("/review");
    expect(live.promptFor("x.compact", "x")).toBeNull();
    expect(liveHarnessCommandPrompt(live.catalog, "x.slash.", "x.slash.missing", "")).toBeNull();
    expect(live.update(null)).toBe(builtIns);
  });

  it("excludes unsuitable live commands but not skills of the same name", () => {
    const catalog = mergeLiveHarnessCommands(
      builtIns,
      "x.slash.",
      [
        { name: "clear", kind: "command" },
        { name: "model", kind: "command" },
        { name: "__remote-workflow", kind: "command" },
        { name: "hooks-add", kind: "command" },
        { name: "share", kind: "skill" },
        { name: "doctor", kind: "command" },
        { name: "review", kind: "command" },
      ],
      { names: ["doctor"] },
    );
    expect(catalog.commands.map(({ invocation }) => invocation)).toEqual([
      "/compact",
      "/share",
      "/review",
    ]);
  });

  it("applies Adapter exclusions to skills too and never filters built-ins", () => {
    expect(isExcludedLiveCommand("/loop", "command")).toBe(true);
    expect(isExcludedLiveCommand("loop", "skill")).toBe(false);
    expect(isExcludedLiveCommand("private", "skill", { names: ["private"] })).toBe(true);
    expect(isExcludedLiveCommand("x-internal", "skill", { prefixes: ["x-"] })).toBe(true);
    const withClearBuiltIn = harnessCommandCatalogSchema.parse({
      commands: [{ id: "x.clear", invocation: "/clear", label: "Clear", argumentMode: "none" }],
    });
    expect(mergeLiveHarnessCommands(withClearBuiltIn, "x.slash.", [])).toEqual(withClearBuiltIn);
  });
});
