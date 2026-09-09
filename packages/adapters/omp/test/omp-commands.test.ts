import { describe, expect, it } from "vitest";
import { ompNativeCommandCatalog, ompNativePrompt } from "../src/omp-commands.js";

describe("OMP native prompt commands", () => {
  it("discovers native file and skill prompts, excluding terminal and unclassified handlers", () => {
    // Shapes observed from OMP get_available_commands; only fixture names/content are synthetic.
    const catalog = ompNativeCommandCatalog({ commands: [] }, [
      { name: "probe", description: "Test $@ arguments", source: "file" },
      { name: "skill:probe", source: "skill" },
      { name: "model", source: "builtin" },
      { name: "local-handler", source: "extension" },
      { name: "probe", source: "file" },
      { name: "../unsafe", source: "file" },
    ]);
    expect(catalog.commands.map((c) => c.invocation)).toEqual(["/omp:probe", "/omp:skill:probe"]);
    expect(catalog.commands.every((c) => c.executionMode === "prompt")).toBe(true);
    expect(ompNativePrompt("/omp:probe one  two\nthree", catalog)).toBe("/probe one  two\nthree");
    expect(ompNativePrompt("  ordinary prompt  ", catalog)).toBe("  ordinary prompt  ");
    expect(() => ompNativePrompt("/omp:gone", catalog)).toThrow("no longer available");
    expect(() => ompNativePrompt("/omp:probe-more", catalog)).toThrow("no longer available");
  });
});
