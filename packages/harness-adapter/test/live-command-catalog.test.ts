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
      { name: "compact" },
      { name: "/review", description: " Review " },
      { name: "review" },
      { name: "template:tdd" },
      { name: "a b" },
      { name: "  " },
    ]);
    expect(catalog.commands).toEqual([
      builtIns.commands[0],
      {
        id: "x.slash.review",
        invocation: "/review",
        label: "review",
        description: "Review",
        argumentMode: "text",
      },
      {
        id: "x.slash.template:tdd",
        invocation: "/template:tdd",
        label: "template:tdd",
        argumentMode: "text",
      },
    ]);
    expect(mergeLiveHarnessCommands(builtIns, "x.slash.", null)).toBe(builtIns);
  });

  it("builds prompt text only for live ids", () => {
    const live = new LiveHarnessCommandCatalog({ idPrefix: "x.slash.", builtIns });
    live.update([{ name: "review" }]);
    expect(live.promptFor("x.slash.review", " 42 ")).toBe("/review 42");
    expect(live.promptFor("x.slash.review", undefined)).toBe("/review");
    expect(live.promptFor("x.compact", "x")).toBeNull();
    expect(liveHarnessCommandPrompt(live.catalog, "x.slash.", "x.slash.missing", "")).toBeNull();
    expect(live.update(null)).toBe(builtIns);
  });

  it("excludes unsuitable live commands by name and prefix", () => {
    const catalog = mergeLiveHarnessCommands(
      builtIns,
      "x.slash.",
      [
        { name: "clear" },
        { name: "model" },
        { name: "__remote-workflow" },
        { name: "hooks-add" },
        { name: "share" },
        { name: "doctor" },
        { name: "review" },
      ],
      { names: ["doctor"] },
    );
    expect(catalog.commands.map(({ invocation }) => invocation)).toEqual(["/compact", "/review"]);
  });

  it("applies Adapter exclusions and never filters built-ins", () => {
    expect(isExcludedLiveCommand("/loop")).toBe(true);
    expect(isExcludedLiveCommand("review")).toBe(false);
    expect(isExcludedLiveCommand("private", { names: ["private"] })).toBe(true);
    expect(isExcludedLiveCommand("x-internal", { prefixes: ["x-"] })).toBe(true);
    const withClearBuiltIn = harnessCommandCatalogSchema.parse({
      commands: [{ id: "x.clear", invocation: "/clear", label: "Clear", argumentMode: "none" }],
    });
    expect(mergeLiveHarnessCommands(withClearBuiltIn, "x.slash.", [])).toEqual(withClearBuiltIn);
  });
});
