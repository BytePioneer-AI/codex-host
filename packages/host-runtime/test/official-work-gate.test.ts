import { describe, expect, it, vi } from "vitest";

import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";

describe("official work publication", () => {
  it("does not duplicate an initialized publication", () => {
    const gate = new OfficialWorkGate();
    const listener = vi.fn();
    gate.subscribe(listener);
    gate.initialized();
    gate.initialized();
    expect(listener).toHaveBeenCalledOnce();
    expect(gate.revision).toBe(1);
  });

  it("cannot finish a stopping change before an independent writer releases its lease", () => {
    const gate = new OfficialWorkGate();
    gate.initialized();
    const release = gate.admit();
    const recovery = gate.beginStoppingChange();
    expect(gate.busy).toBe(true);
    expect(() => recovery.assertIdle()).toThrow("busy");
    expect(() => recovery.finish("ready")).toThrow("busy");
    release();
    recovery.assertIdle();
    recovery.finish("ready");
    expect(gate.phase).toBe("ready");
  });

  it("does not interrupt an admitted request to recover", () => {
    const gate = new OfficialWorkGate();
    gate.initialized();
    const release = gate.admit();
    gate.unavailable();
    expect(() => gate.beginChange(true)).toThrow("busy");
    release();
    gate.beginChange(true).finish("ready");
  });

  it("keeps the exclusive change lease after native cleanup becomes unavailable", () => {
    const gate = new OfficialWorkGate();
    gate.initialized();
    const change = gate.beginChange();
    gate.unavailable();
    expect(() => gate.beginChange(true)).toThrow("changing");
    expect(() => change.finish("ready")).toThrow("unavailable");
    expect(gate.phase).toBe("unavailable");
  });
});
