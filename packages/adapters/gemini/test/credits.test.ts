import { describe, expect, it, vi } from "vitest";

import { fetchGeminiCredits } from "../src/gemini-credits.js";

describe("Gemini credits", () => {
  it("does not perform network access without an explicitly injected endpoint and fetch", async () => {
    const fetch = vi.fn();
    await expect(fetchGeminiCredits({ fetch })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only the explicitly injected endpoint", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      fetchGeminiCredits({
        endpoint: "https://provider.example/credits",
        fetch,
        readAuthFile: async () => JSON.stringify({ provider: { key: "token" } }),
      }),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "https://provider.example/credits",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
