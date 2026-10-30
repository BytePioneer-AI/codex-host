import { describe, expect, it, vi } from "vitest";
import {
  OfficialAdmissionError,
  OfficialWorkGate,
} from "../src/codex-runtime/official-work-gate.js";

describe("official work admission", () => {
  it("admits requests only after initialization", () => {
    const gate = new OfficialWorkGate();
    expect(() => gate.admit()).toThrow("unavailable");
    gate.initialized();
    const first = gate.admit();
    const second = gate.admit();
    expect(gate.busy).toBe(true);
    expect(() => gate.initialized()).toThrow("busy");
    first();
    first();
    expect(gate.busy).toBe(true);
    second();
    expect(gate.busy).toBe(false);
  });

  it("blocks new requests after backend loss while allowing pending requests to settle", () => {
    const gate = new OfficialWorkGate();
    gate.initialized();
    const release = gate.admit();
    gate.unavailable();
    expect(() => gate.admit()).toThrow("unavailable");
    release();
    expect(gate.busy).toBe(false);
    gate.initialized();
    expect(gate.phase).toBe("ready");
  });

  it("publishes only phase changes and isolates subscribers", () => {
    const gate = new OfficialWorkGate();
    gate.subscribe(() => {
      throw new Error("subscriber failure");
    });
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);
    gate.initialized();
    gate.initialized();
    expect(gate.revision).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    gate.unavailable();
    expect(gate.revision).toBe(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("preserves admission error causes", () => {
    const cause = new Error("transport failed");
    expect(new OfficialAdmissionError("unavailable", cause).cause).toBe(cause);
  });
});
