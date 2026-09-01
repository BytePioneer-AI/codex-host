import { describe, expect, it } from "vitest";

import { grokActiveModelReminder } from "../src/grok-models.js";

describe("Grok live Model reminder", () => {
  it("names the active Model and thinking so the agent does not keep the baked identity", () => {
    expect(grokActiveModelReminder("Grok 4.6", "High")).toContain(
      "The active model for this turn is Grok 4.6. Reasoning effort is High.",
    );
    expect(grokActiveModelReminder("Grok 4.5")).toContain(
      "If asked which model you are, answer Grok 4.5.",
    );
  });
});
