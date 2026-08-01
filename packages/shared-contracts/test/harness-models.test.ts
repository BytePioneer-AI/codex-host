import { describe, expect, it } from "vitest";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessModelSelectionStateSchema,
  piHarnessInspectParamsSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
} from "@codexhost/shared-contracts";

const firstRef = { id: "pi-model-v1.cHJvdmlkZXI6bW9kZWw" };
const secondRef = { id: "pi-model-v1.b3RoZXI6bW9kZWw" };

function readyInspection() {
  return {
    status: "ready",
    catalog: {
      models: [
        { ref: firstRef, label: "provider / model" },
        { ref: secondRef, label: "other / model" },
      ],
      defaultModel: firstRef,
    },
    capabilities: {
      configuration: { selectModel: true },
      history: { fork: true, forkAcrossCwd: true },
    },
  };
}

describe("Harness Model runtime contracts", () => {
  it("accepts a strict browser-safe ready inspection", () => {
    expect(harnessInspectionSchema.parse(readyInspection())).toEqual(readyInspection());
    expect(harnessModelSelectionStateSchema.parse({ effectiveModel: firstRef })).toEqual({
      effectiveModel: firstRef,
    });
  });

  it("rejects native configuration and unknown fields", () => {
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: { selectModel: true },
          history: { fork: true },
        },
      }).success,
    ).toBe(false);
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: { selectModel: true },
          history: { fork: false, forkAcrossCwd: true },
        },
      }).success,
    ).toBe(false);
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        catalog: {
          ...readyInspection().catalog,
          models: [
            {
              ref: firstRef,
              label: "provider / model",
              provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      harnessModelSelectionStateSchema.safeParse({
        effectiveModel: firstRef,
        nativeState: { modelId: "private" },
      }).success,
    ).toBe(false);
  });

  it("requires bounded transport-safe opaque Model refs", () => {
    for (const id of [
      "",
      "   ",
      "provider/model",
      "provider:model",
      "provider model",
      "x".repeat(HARNESS_MODEL_REF_MAX_LENGTH + 1),
    ]) {
      expect(harnessModelRefSchema.safeParse({ id }).success).toBe(false);
    }
    expect(harnessModelRefSchema.parse(firstRef)).toEqual(firstRef);
  });

  it("rejects duplicate refs and a default outside the catalog", () => {
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          { ref: firstRef, label: "first" },
          { ref: firstRef, label: "duplicate" },
        ],
        defaultModel: firstRef,
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [{ ref: firstRef, label: "first" }],
        defaultModel: secondRef,
      }).success,
    ).toBe(false);
  });

  it("keeps inspection and Thread selection params method-specific", () => {
    expect(
      piHarnessInspectParamsSchema.parse({
        harnessId: "pi",
        cwd: "/synthetic",
        refresh: true,
      }),
    ).toEqual({ harnessId: "pi", cwd: "/synthetic", refresh: true });
    expect(threadModelSelectParamsSchema.parse({ threadId: "thread-1", model: firstRef })).toEqual({
      threadId: "thread-1",
      model: firstRef,
    });

    expect(
      piHarnessInspectParamsSchema.safeParse({
        harnessId: "pi",
        method: "get_available_models",
      }).success,
    ).toBe(false);
    expect(
      threadModelSelectParamsSchema.safeParse({
        threadId: "thread-1",
        model: firstRef,
        provider: "private-provider",
      }).success,
    ).toBe(false);
  });

  it("validates fixed Thread ownership inspection without Native details", () => {
    expect(threadInspectionParamsSchema.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(
      threadInspectionSchema.parse({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: firstRef,
        locked: true,
      }),
    ).toMatchObject({ owner: "external", harnessId: "pi", locked: true });
    expect(threadInspectionSchema.parse({ owner: "codex", locked: true })).toEqual({
      owner: "codex",
      locked: true,
    });
    expect(
      threadInspectionSchema.safeParse({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        locked: true,
        nativeSessionRef: { nativeSessionId: "secret" },
      }).success,
    ).toBe(false);
  });

  it("validates normalized inspection failures without arbitrary diagnostics", () => {
    expect(
      harnessInspectionSchema.parse({
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Pi is not installed",
          retryable: false,
        },
      }),
    ).toMatchObject({ status: "notInstalled", error: { code: "notInstalled" } });
    expect(
      harnessInspectionSchema.safeParse({
        status: "error",
        error: {
          code: "nativeFailure",
          message: "Private failure",
          retryable: false,
          nativePayload: { apiKey: "secret" },
        },
      }).success,
    ).toBe(false);
  });
});
