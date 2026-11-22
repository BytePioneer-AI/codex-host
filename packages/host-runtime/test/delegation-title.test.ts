import { describe, expect, it } from "vitest";

import { delegationTitle, threadWatchLabel } from "../src/delegation-title.js";

describe("delegation titles", () => {
  it("uses only the normalized task name", () => {
    expect(
      delegationTitle({ taskName: "  summary-row\n review  ", task: "Full instructions" }),
    ).toBe("summary-row review");
  });

  it("keeps the first task line fallback and its Unicode-safe 120-code-unit limit", () => {
    expect(delegationTitle({ task: "\n  Review\t protocols\nFull instructions" })).toBe(
      "Review protocols",
    );
    expect(delegationTitle({ task: `${"x".repeat(119)}🐙\nDetails` })).toBe("x".repeat(119));
  });
});

describe("watch notification labels", () => {
  it.each([undefined, ""])("falls back to the Thread id for %s", (title) => {
    expect(threadWatchLabel(title, "child")).toBe("child");
  });

  it.each(["summary-row", "Review · Short parent", "No separator " + "🐙".repeat(30)])(
    "preserves names without a long suffix (%s)",
    (title) => {
      expect(threadWatchLabel(title, "child")).toBe(title);
    },
  );

  it("caps the complete suffix at 20 Unicode characters, including nested separators", () => {
    const prefix = "summary-row · ";
    const suffix = "🐙".repeat(20);
    expect(threadWatchLabel(prefix + suffix, "child")).toBe(prefix + suffix);
    expect(threadWatchLabel(prefix + suffix + " · Parent task", "child")).toBe(
      prefix + suffix + "…",
    );
  });
});
