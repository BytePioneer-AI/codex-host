import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";
import type { HarnessExecutionPolicy, OpenSessionInput } from "../src/index.js";

describe("harness-adapter package", () => {
  it("participates in the shared contract", () => {
    expect(packageMetadata).toEqual({
      name: "@codexhost/harness-adapter",
      contractVersion: 1,
    });
  });

  it("exports the create-time execution policy contract", () => {
    const policy: HarnessExecutionPolicy = "approval-required";
    expect(policy).toBe("approval-required");
  });

  it("carries execution policy through every recovery input", () => {
    const nativeRef = {
      harnessId: "claude-code",
      nativeSessionId: "native-1",
      formatVersion: 1,
    } as const;
    const checkpoint = { ...nativeRef, nativeCheckpointKey: "checkpoint-1" } as const;
    const inputs: OpenSessionInput[] = [
      { kind: "resume", cwd: "/workspace", nativeRef, executionPolicy: "approval-required" },
      {
        kind: "fork",
        cwd: "/workspace",
        sourceRef: nativeRef,
        checkpoint,
        executionPolicy: "unattended-full-access",
      },
      {
        kind: "rollbackLastTurn",
        cwd: "/workspace",
        sourceRef: nativeRef,
        executionPolicy: "approval-required",
      },
    ];

    expect(inputs.map((input) => input.executionPolicy)).toEqual([
      "approval-required",
      "unattended-full-access",
      "approval-required",
    ]);
  });
});
