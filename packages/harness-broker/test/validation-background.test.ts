import { describe, expect, it } from "vitest";

import { harnessOutputSchema } from "../src/validation.js";

describe("background output validation", () => {
  const item = { type: "agentMessage", itemId: "item-1", text: "hello" };
  const output = (turnId: unknown, value: unknown) => ({
    kind: "event",
    event: { type: "item.background.started", turnId, item: value },
  });

  it("accepts text Items and rejects malformed or extra fields", () => {
    expect(harnessOutputSchema.safeParse(output("turn-1", item)).success).toBe(true);
    expect(
      harnessOutputSchema.safeParse(output("turn-1", { ...item, type: "reasoning" })).success,
    ).toBe(true);
    for (const invalid of [
      output("", item),
      output("turn-1", { ...item, type: "commandExecution" }),
      output("turn-1", { ...item, itemId: "" }),
      output("turn-1", { ...item, text: 1 }),
      output("turn-1", { ...item, extra: true }),
    ]) {
      expect(harnessOutputSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
