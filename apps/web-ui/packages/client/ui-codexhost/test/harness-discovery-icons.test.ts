import { describe, expect, it } from "vitest";
import { harnessAgentIcon } from "../src/client/harness-discovery.tsx";

describe("harnessAgentIcon stability", () => {
  it("returns the same component reference for identical harness and host identities", () => {
    const first = harnessAgentIcon("claude-code");
    const second = harnessAgentIcon("claude-code");
    expect(first).toBe(second);

    const remoteFirst = harnessAgentIcon("claude-code", "remote-peer:alpha");
    const remoteSecond = harnessAgentIcon("claude-code", "remote-peer:alpha");
    expect(remoteFirst).toBe(remoteSecond);
    expect(remoteFirst).not.toBe(first);

    const otherHarness = harnessAgentIcon("codex");
    expect(otherHarness).not.toBe(first);
  });
});
