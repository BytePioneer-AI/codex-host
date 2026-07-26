import { describe, expect, it } from "vitest";

import {
  codexhostErrorSchema,
  harnessIdSchema,
  hostThreadIdSchema,
  jsonRpcEnvelopeSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  packageMetadata,
  WORKSPACE_CONTRACT_VERSION,
  workspaceContractVersionSchema,
} from "@codexhost/shared-contracts";

describe("shared-contracts public package", () => {
  it("exports the unchanged workspace contract version", () => {
    expect(WORKSPACE_CONTRACT_VERSION).toBe(1);
    expect(workspaceContractVersionSchema.parse(1)).toBe(1);
    expect(packageMetadata.contractVersion).toBe(1);
  });

  it("exports representative runtime contracts from the package root", () => {
    expect(jsonValueSchema.parse({ public: true })).toEqual({ public: true });
    expect(harnessIdSchema.parse("pi")).toBe("pi");
    expect(hostThreadIdSchema.parse("thread")).toBe("thread");
    expect(jsonRpcEnvelopeSchema.parse({ id: 1, result: null })).toEqual({ id: 1, result: null });
    expect(
      nativeSessionRefSchema.parse({
        harnessId: "pi",
        nativeSessionId: "synthetic-session",
        formatVersion: 1,
      }),
    ).toEqual({ harnessId: "pi", nativeSessionId: "synthetic-session", formatVersion: 1 });
    expect(
      codexhostErrorSchema.parse({
        code: "SYNTHETIC",
        message: "Synthetic error.",
        retryable: false,
      }),
    ).toEqual({ code: "SYNTHETIC", message: "Synthetic error.", retryable: false });
  });
});
