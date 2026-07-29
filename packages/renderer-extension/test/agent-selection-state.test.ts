import { describe, expect, it } from "vitest";

import { AgentSelectionRegistry } from "../src/index.js";

describe("Renderer Agent selection state", () => {
  it("isolates Agent selection by Composer", () => {
    const firstComposer = {};
    const secondComposer = {};
    const registry = new AgentSelectionRegistry<object>({
      idFactory: (kind, sequence) => `${kind}-${sequence}`,
    });

    registry.setAgent(firstComposer, "pi");

    expect(registry.get(firstComposer)).toMatchObject({
      composerId: "composer-1",
      agent: "pi",
      phase: "draft",
    });
    expect(registry.get(secondComposer)).toMatchObject({
      composerId: "composer-2",
      agent: "codex",
      phase: "draft",
    });
  });

  it("keeps the draft mutable until submission locks the final Agent", () => {
    const composer = {};
    const registry = new AgentSelectionRegistry<object>({
      idFactory: (kind, sequence) => `${kind}-${sequence}`,
    });

    registry.setAgent(composer, "pi");
    registry.setAgent(composer, "codex");
    registry.setAgent(composer, "pi");
    expect(registry.get(composer)).toMatchObject({ agent: "pi", phase: "draft" });

    registry.lock(composer);
    registry.setAgent(composer, "codex");
    expect(registry.get(composer)).toMatchObject({
      composerId: "composer-1",
      agent: "pi",
      phase: "locked",
    });
  });

  it("transfers state only to an untracked replacement Composer", () => {
    const originalComposer = {};
    const replacementComposer = {};
    const existingComposer = {};
    const registry = new AgentSelectionRegistry<object>({
      idFactory: (kind, sequence) => `${kind}-${sequence}`,
    });
    registry.setAgent(originalComposer, "pi");
    registry.lock(originalComposer);
    registry.setAgent(existingComposer, "codex");

    expect(registry.transfer(originalComposer, replacementComposer)).toBe(true);
    expect(registry.get(replacementComposer)).toMatchObject({
      composerId: "composer-1",
      agent: "pi",
      phase: "locked",
    });
    expect(registry.transfer(originalComposer, existingComposer)).toBe(false);
    expect(registry.get(existingComposer)).toMatchObject({
      composerId: "composer-2",
      agent: "codex",
    });
  });

  it("captures the final Agent once for duplicate DOM submit signals", () => {
    let now = Date.parse("2026-07-27T12:00:00.000Z");
    const composer = {};
    const registry = new AgentSelectionRegistry<object>({
      clock: () => now,
      dedupeWindowMs: 250,
      idFactory: (kind, sequence) => `${kind}-${sequence}`,
    });
    registry.setAgent(composer, "pi");

    expect(registry.capture(composer, "enter")).toEqual({
      submissionId: "submission-1",
      composerId: "composer-1",
      agent: "pi",
      trigger: "enter",
      capturedAt: "2026-07-27T12:00:00.000Z",
    });
    now += 100;
    expect(registry.capture(composer, "submit")).toBeNull();
    now += 200;
    expect(registry.capture(composer, "click")).toMatchObject({
      submissionId: "submission-2",
      agent: "pi",
      trigger: "click",
    });
  });
});
