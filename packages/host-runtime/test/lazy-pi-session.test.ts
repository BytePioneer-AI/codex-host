import { describe, expect, it, vi } from "vitest";

import { LazyPiSession, type PiTextSession } from "../src/index.js";

function fakeSession(output: string): PiTextSession & {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  runTextTurn: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    runTextTurn: vi.fn(async (_text: string, onDelta?: (delta: string) => void) => {
      onDelta?.(output);
      return { text: output };
    }),
  };
}

describe("lazy Pi prewarm session", () => {
  it("does not create a process owner for an unused prewarm", async () => {
    const factory = vi.fn(() => fakeSession("unused"));
    const lazy = new LazyPiSession(factory);

    expect(lazy.started).toBe(false);
    await lazy.close();
    expect(factory).not.toHaveBeenCalled();
  });

  it("starts once on the first Turn and reuses the Session", async () => {
    const session = fakeSession("pi-output");
    const factory = vi.fn(() => session);
    const lazy = new LazyPiSession(factory);

    await expect(lazy.runTextTurn("first")).resolves.toEqual({ text: "pi-output" });
    await expect(lazy.runTextTurn("second")).resolves.toEqual({ text: "pi-output" });

    expect(factory).toHaveBeenCalledOnce();
    expect(session.start).toHaveBeenCalledOnce();
    expect(session.runTextTurn).toHaveBeenCalledTimes(2);
    await lazy.close();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("closes a partially started Session after startup failure", async () => {
    const session = fakeSession("unused");
    session.start.mockRejectedValueOnce(new Error("synthetic startup failure"));
    const lazy = new LazyPiSession(() => session);

    await expect(lazy.runTextTurn("first")).rejects.toThrow("synthetic startup failure");
    expect(session.close).toHaveBeenCalledOnce();
    expect(lazy.started).toBe(false);
  });
});
