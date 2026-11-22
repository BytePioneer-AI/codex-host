import { describe, expect, it } from "vitest";
import { orderHarnessDisplay } from "../src/harness-display-settings.js";

const catalog = ["zcode", "grok", "codex", "claude-code", "pi", "opencode"].map((id) => ({
  id,
  name: id,
}));
describe("shared Harness display order", () => {
  it("pins Codex and follows the Desktop defaults without changing the input", () => {
    const original = [...catalog];
    expect(orderHarnessDisplay(catalog).map((item) => item.id)).toEqual([
      "codex",
      "pi",
      "claude-code",
      "opencode",
      "grok",
      "zcode",
    ]);
    expect(catalog).toEqual(original);
  });
  it("honors saved order and flattens More after Main without inventing plugins", () => {
    expect(
      orderHarnessDisplay(catalog, [
        { agent: "grok", section: "main" },
        { agent: "absent", section: "main" },
        { agent: "pi", section: "more" },
        { agent: "codex", section: "more" },
      ]).map((item) => item.id),
    ).toEqual(["codex", "grok", "claude-code", "opencode", "zcode", "pi"]);
  });
});
