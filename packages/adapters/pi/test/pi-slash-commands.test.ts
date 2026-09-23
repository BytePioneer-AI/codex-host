import { describe, expect, it } from "vitest";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";

import {
  parsePiNativeCommands,
  piDynamicCommandPrompt,
  piLiveCommandCatalog,
} from "../src/pi-slash-commands.js";

const builtIns = harnessCommandCatalogSchema.parse({
  commands: [{ id: "pi.compact", invocation: "/compact", label: "Compact", argumentMode: "text" }],
});

describe("Pi live command catalog", () => {
  const native = parsePiNativeCommands({
    data: {
      commands: [
        { name: "compact", source: "extension" },
        { name: "subagents-inspect-rpc", source: "extension" },
        { name: "review", description: "Review changes", source: "prompt" },
        { name: "skill:brave-search", description: "Search the web", source: "skill" },
      ],
    },
  });

  it("appends live commands, marks skills and hides internal RPC helpers", () => {
    const catalog = piLiveCommandCatalog(builtIns, native);
    expect(catalog.commands.map(({ invocation, kind }) => [invocation, kind])).toEqual([
      ["/compact", undefined],
      ["/review", "command"],
      ["/skill:brave-search", "skill"],
    ]);
  });

  it("tolerates malformed responses", () => {
    expect(parsePiNativeCommands(null)).toEqual([]);
    expect(parsePiNativeCommands({ data: { commands: "x" } })).toEqual([]);
    expect(piLiveCommandCatalog(builtIns, null)).toBe(builtIns);
  });

  it("builds prompt text for dynamic commands", () => {
    const catalog = piLiveCommandCatalog(builtIns, native);
    expect(piDynamicCommandPrompt(catalog, "pi.slash.skill:brave-search", "cats")).toBe(
      "/skill:brave-search cats",
    );
    expect(piDynamicCommandPrompt(catalog, "pi.compact", undefined)).toBeNull();
  });
});
