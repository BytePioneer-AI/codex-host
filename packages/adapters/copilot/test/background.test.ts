import { describe, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { CopilotBackground } from "../src/background.js";

describe("Copilot native task lease", () => {
  it("retains the lease across invalidation, coalesces reads, and clears only on native completion", async () => {
    const first = Promise.withResolvers<{ tasks: Array<{ status: string }> }>();
    const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ tasks: [] });
    const session = { rpc: { tasks: { list } } } as unknown as CopilotSession;
    const background = new CopilotBackground();
    background.invalidate();
    expect(background.hasWork()).toBe(true);
    const refreshing = background.refresh(session);
    expect(background.refresh(session)).toBe(refreshing);
    first.resolve({ tasks: [{ status: "running" }] });
    await refreshing;
    expect(background.hasWork()).toBe(true);
    background.invalidate();
    await background.refresh(session);
    expect(background.hasWork()).toBe(false);
  });
  it("keeps ownership on failed reads", async () => {
    const background = new CopilotBackground();
    background.invalidate();
    const session = {
      rpc: {
        tasks: {
          list: async () => {
            throw new Error("native connection lost");
          },
        },
      },
    } as unknown as CopilotSession;
    await expect(background.refresh(session)).rejects.toThrow();
    expect(background.hasWork()).toBe(true);
  });
});
