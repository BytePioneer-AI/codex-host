import { z } from "zod";
import { describe, expect, it } from "vitest";

import { codexhostErrorSchema } from "../src/index.js";
import type { CodexhostError } from "../src/index.js";

const mappingStoreErrorSchema = codexhostErrorSchema.safeExtend({
  code: z.enum(["IO_ERROR", "MAPPING_CONFLICT"]),
});

function assertExactOptionalDiagnostic(error: CodexhostError): void {
  // @ts-expect-error Explicit undefined is not an optional diagnostic.
  const invalidError: CodexhostError = { ...error, diagnostic: undefined };
  void invalidError;
}

void assertExactOptionalDiagnostic;

describe("codexhost cross-boundary error contract", () => {
  it("accepts the minimal shared structure without fixing a global code enum", () => {
    const error = {
      code: "adapterSpecificFailure",
      message: "The operation could not be completed.",
      retryable: true,
      diagnostic: "Synthetic bounded diagnostic.",
    };

    expect(codexhostErrorSchema.parse(error)).toEqual(error);
  });

  it.each([
    { message: "missing code", retryable: false },
    { code: "", message: "empty code", retryable: false },
    { code: "INVALID", message: "", retryable: false },
    { code: "INVALID", message: "missing retryable" },
    { code: "INVALID", message: "wrong retryable", retryable: "no" },
    { code: "INVALID", message: "empty diagnostic", retryable: false, diagnostic: "" },
    { code: "INVALID", message: "undefined diagnostic", retryable: false, diagnostic: undefined },
    { code: "INVALID", message: "extended", retryable: false, extra: true },
  ])("rejects incomplete or extended errors %#", (value) => {
    expect(codexhostErrorSchema.safeParse(value).success).toBe(false);
  });

  it("allows owning packages to narrow code without changing the shared schema", () => {
    const storeError = {
      code: "IO_ERROR",
      message: "The mapping could not be saved.",
      retryable: true,
    } as const;

    expect(mappingStoreErrorSchema.parse(storeError)).toEqual(storeError);
    expect(
      mappingStoreErrorSchema.safeParse({ ...storeError, code: "adapterSpecificFailure" }).success,
    ).toBe(false);
    expect(
      codexhostErrorSchema.safeParse({ ...storeError, code: "adapterSpecificFailure" }).success,
    ).toBe(true);
  });

  it("uses only synthetic, bounded diagnostics", () => {
    const serialized = JSON.stringify({
      code: "SYNTHETIC",
      message: "The synthetic operation failed.",
      retryable: false,
      diagnostic: "No external process was used.",
    });

    expect(serialized).not.toMatch(
      /transcript|prompt|tool.?output|diff|access.?token|api.?key|oauth|[A-Z]:\\|\/Users\//iu,
    );
  });
});
