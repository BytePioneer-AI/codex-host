import { describe, expect, it, vi } from "vitest";

import { installRendererDraftPrewarmPolicy } from "../src/renderer-draft-prewarm-policy.js";

describe("Renderer draft prewarm policy", () => {
  it("installs the official clear bridge for one owned Renderer", async () => {
    const evaluate = vi.fn();
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        evaluate(expression);
        return { state: "ready", reason: "owned-request-bridge" } as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 17)).resolves.toEqual({
      state: "ready",
      reason: "owned-request-bridge",
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toContain("webContents.fromId(17)");
    expect(evaluate.mock.calls[0]?.[0]).toContain("__reactFiber$");
    expect(evaluate.mock.calls[0]?.[0]).toContain("hostId !== 'local'");
    expect(evaluate.mock.calls[0]?.[0]).toContain("clear-prewarmed-threads-for-host");
  });

  it("rejects an invalid Renderer identity before inspecting the Desktop", async () => {
    const evaluate = vi.fn();
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        evaluate(expression);
        throw new Error("Unexpected inspection");
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 0)).rejects.toThrow(
      "Renderer webContents ID must be a positive integer",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid installation result", async () => {
    const evaluate = vi.fn();
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        evaluate(expression);
        return { state: "ready", reason: "ambiguous" } as T;
      },
    };

    await expect(installRendererDraftPrewarmPolicy(inspector, 17)).rejects.toThrow(
      "Renderer draft prewarm policy returned an invalid status",
    );
  });
});
