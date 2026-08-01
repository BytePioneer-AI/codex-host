import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { SessionStateObserver } from "../src/session-state-observer.js";

const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });

describe("Host Session state observer", () => {
  it("resolves waiters only after a newer complete state is observed", async () => {
    const observer = new SessionStateObserver({});
    const waiting = observer.waitForChange(observer.revision);

    const effectiveThinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const availableThinkingOptions = [
      harnessThinkingOptionSchema.parse({ id: "off", label: "Off" }),
      harnessThinkingOptionSchema.parse({ id: "high", label: "High" }),
    ];
    const state = { effectiveModel: model, effectiveThinkingOptionId, availableThinkingOptions };
    observer.update(state);

    await expect(waiting).resolves.toEqual(state);
    expect(observer.revision).toBe(1);
    expect(observer.state).toEqual(state);
  });

  it("returns an already-observed revision without adding a waiter", async () => {
    const observer = new SessionStateObserver({});
    observer.update({ effectiveModel: model });

    await expect(observer.waitForChange(0)).resolves.toEqual({ effectiveModel: model });
  });

  it("rejects pending state operations when the Session faults", async () => {
    const observer = new SessionStateObserver({});
    const waiting = observer.waitForChange(0);

    observer.fault(new Error("synthetic Session fault"));

    await expect(waiting).rejects.toThrow("synthetic Session fault");
  });
});
