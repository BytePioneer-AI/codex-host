import { describe, expect, it } from "vitest";

import { matchingHarnessCommands } from "../src/renderer-command-picker.js";

const commands = [
  {
    id: "pi.compact",
    invocation: "/compact",
    label: "Compact context",
    description: "Compact the current conversation context",
    argumentMode: "text" as const,
  },
  {
    id: "fake.review",
    invocation: "/review",
    label: "Review",
    argumentMode: "none" as const,
  },
];

describe("Renderer native command menu augmentation", () => {
  it("places only commands matching the current slash query", () => {
    expect(matchingHarnessCommands(commands, "/")).toEqual(commands);
    expect(matchingHarnessCommands(commands, "/com")).toEqual([commands[0]]);
  });

  it("does not augment the native menu for ordinary or argument text", () => {
    expect(matchingHarnessCommands(commands, "compact")).toEqual([]);
    expect(matchingHarnessCommands(commands, "/compact keep details")).toEqual([]);
  });
});
