import { describe, expect, it } from "vitest";

import { deriveCapabilities } from "./capabilities.mjs";

function scenario(id, status, facts = {}) {
  return { id, status, facts };
}

describe("Claude Probe capability derivation", () => {
  it("requires all evidence scenarios for a capability", () => {
    const capabilities = deriveCapabilities([
      scenario("live-text-multiturn", "PASS"),
      scenario("live-resume", "PASS"),
    ]);
    expect(capabilities.find(({ id }) => id === "caller-user-native-ref")?.status).toBe(
      "supported",
    );
    expect(capabilities.find(({ id }) => id === "exact-context-fork")?.status).toBe("not-observed");
  });

  it("derives Warm, authentication, and streaming interrupt independently", () => {
    const capabilities = deriveCapabilities([
      scenario("warm-no-prompt", "PASS"),
      scenario("live-auth-setting-sources", "PASS"),
      scenario("live-streaming-cancel", "PASS"),
    ]);
    expect(capabilities.find(({ id }) => id === "startup-without-empty-session")?.status).toBe(
      "supported",
    );
    expect(capabilities.find(({ id }) => id === "native-user-settings-auth")?.status).toBe(
      "supported",
    );
    expect(capabilities.find(({ id }) => id === "streaming-interrupt")?.status).toBe("supported");
  });

  it("keeps optional Progress unobserved when no Progress event exists", () => {
    const capabilities = deriveCapabilities([
      scenario("live-tool-edit", "PASS", { toolProgressCount: 0 }),
      scenario("live-tool-cancel", "PASS", { toolProgressCount: 0 }),
    ]);
    expect(capabilities.find(({ id }) => id === "tool-progress")?.status).toBe("not-observed");
  });
});
