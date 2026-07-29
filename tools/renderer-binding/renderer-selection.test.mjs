import { describe, expect, it, vi } from "vitest";

import {
  selectRendererWebContents,
  waitForRendererTitlePolicyReady,
} from "./renderer-selection.mjs";

function renderer(surface, elementCount) {
  return {
    type: "window",
    surface,
    runtime: {
      available: true,
      elementCount,
    },
  };
}

describe("Renderer binding selection", () => {
  it("selects the populated primary window even when an overlay is ready first", () => {
    const primary = renderer("primary", 100);

    expect(selectRendererWebContents([renderer("overlay", 1_000), primary])).toBe(primary);
  });

  it("waits for metadata-service ownership before marking the Renderer ready", async () => {
    let currentTime = 0;
    const markReadiness = vi
      .fn()
      .mockRejectedValueOnce(new Error("ownership unavailable"))
      .mockResolvedValue({ state: "ready", reason: "owned-metadata-service" });

    await expect(
      waitForRendererTitlePolicyReady(markReadiness, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toEqual({ state: "ready", reason: "owned-metadata-service" });
    expect(markReadiness).toHaveBeenCalledTimes(2);
  });
});
