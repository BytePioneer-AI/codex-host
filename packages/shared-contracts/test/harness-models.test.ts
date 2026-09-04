import { describe, expect, it } from "vitest";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  HARNESS_THINKING_OPTION_ID_MAX_LENGTH,
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessModelSelectionStateSchema,
  harnessModelSelectionScopeSchema,
  harnessThinkingOptionIdSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
} from "@codexhost/shared-contracts";

const firstRef = { id: "pi-model-v1.cHJvdmlkZXI6bW9kZWw" };
const secondRef = { id: "pi-model-v1.b3RoZXI6bW9kZWw" };

function readyInspection() {
  return {
    status: "ready",
    catalog: {
      models: [
        {
          ref: firstRef,
          label: "provider / model",
          resolvedModelLabel: "runtime/model-v1",
          supportedThinkingOptionIds: ["off", "high"],
        },
        { ref: secondRef, label: "other / model" },
      ],
      defaultModel: firstRef,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
    },
  };
}

describe("Harness Model runtime contracts", () => {
  it("accepts a strict browser-safe ready inspection", () => {
    expect(harnessInspectionSchema.parse(readyInspection())).toEqual(readyInspection());
    expect(
      harnessModelSelectionStateSchema.parse({
        effectiveModel: firstRef,
        resolvedModelLabel: "runtime/model-v1",
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
      }),
    ).toMatchObject({
      effectiveModel: firstRef,
      resolvedModelLabel: "runtime/model-v1",
      effectiveThinkingOptionId: "high",
    });
    expect(JSON.parse(JSON.stringify(harnessInspectionSchema.parse(readyInspection())))).toEqual(
      readyInspection(),
    );
  });

  it("preserves the Model selection scope", () => {
    const base = readyInspection();
    const inspection = {
      ...base,
      capabilities: {
        ...base.capabilities,
        configuration: {
          ...base.capabilities.configuration,
          modelSelectionScope: harnessModelSelectionScopeSchema.parse("atCreate"),
        },
      },
    };
    expect(harnessInspectionSchema.parse(inspection)).toMatchObject({
      capabilities: { configuration: { modelSelectionScope: "atCreate" } },
    });
  });

  it("rejects native configuration and unknown fields", () => {
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: true },
        },
      }).success,
    ).toBe(false);
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(),
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: false,
          },
          history: { fork: false, forkAcrossCwd: true, rollbackLastTurn: false },
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
    expect(
      threadModelSelectParamsSchema.safeParse({
        threadId: "thread-1",
        model: firstRef,
        resolvedModelLabel: "runtime/model-v1",
      }).success,
    ).toBe(false);
    for (const resolvedModelLabel of ["", "   ", "x".repeat(257)]) {
      expect(
        harnessModelSelectionStateSchema.safeParse({
          effectiveModel: firstRef,
          resolvedModelLabel,
        }).success,
      ).toBe(false);
    }
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
    for (const id of [
      "",
      "thinking option",
      "thinking/option",
      "x".repeat(HARNESS_THINKING_OPTION_ID_MAX_LENGTH + 1),
    ]) {
      expect(harnessThinkingOptionIdSchema.safeParse(id).success).toBe(false);
    }
    expect(harnessThinkingOptionIdSchema.parse("xhigh")).toBe("xhigh");
  });

  it("rejects duplicate refs and a default outside the catalog", () => {
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          { ref: firstRef, label: "first" },
          { ref: firstRef, label: "duplicate" },
        ],
        defaultModel: firstRef,
        thinkingOptions: [],
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [{ ref: firstRef, label: "first" }],
        defaultModel: secondRef,
        thinkingOptions: [],
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          {
            ref: firstRef,
            label: "first",
            supportedThinkingOptionIds: ["missing"],
          },
        ],
        defaultModel: firstRef,
        thinkingOptions: [{ id: "off", label: "Off" }],
        defaultThinkingOptionId: "missing",
      }).success,
    ).toBe(false);
    expect(
      harnessModelCatalogSchema.safeParse({
        models: [
          {
            ref: firstRef,
            label: "first",
            supportedThinkingOptionIds: ["off", "off"],
          },
        ],
        thinkingOptions: [{ id: "off", label: "Off" }],
      }).success,
    ).toBe(false);
    expect(
      harnessModelSelectionStateSchema.safeParse({
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [{ id: "off", label: "Off" }],
      }).success,
    ).toBe(false);
  });

  it("keeps inspection and Thread selection params method-specific", () => {
    expect(
      harnessInspectParamsSchema.parse({
        harnessId: "pi",
        cwd: "/synthetic",
        refresh: true,
      }),
    ).toEqual({ harnessId: "pi", cwd: "/synthetic", refresh: true });
    expect(harnessInspectParamsSchema.parse({ harnessId: "claude-code" })).toEqual({
      harnessId: "claude-code",
    });
    expect(threadModelSelectParamsSchema.parse({ threadId: "thread-1", model: firstRef })).toEqual({
      threadId: "thread-1",
      model: firstRef,
    });
    expect(
      threadThinkingSelectParamsSchema.parse({
        threadId: "thread-1",
        thinkingOptionId: "high",
      }),
    ).toEqual({ threadId: "thread-1", thinkingOptionId: "high" });

    expect(
      harnessInspectParamsSchema.safeParse({
        harnessId: "pi",
        model: firstRef,
      }).success,
    ).toBe(false);
    expect(
      harnessInspectParamsSchema.safeParse({
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
        resolvedModelLabel: "runtime/model-v1",
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
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
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
        nativeSessionRef: { nativeSessionId: "secret" },
      }).success,
    ).toBe(false);
  });

  it("validates strict bounded Thread ownership lists", () => {
    const params = { threadIds: ["official-thread", "pi-thread", "claude-thread"] };
    const result = {
      threads: [
        { threadId: "official-thread", owner: "codex" as const },
        { threadId: "pi-thread", owner: "external" as const, harnessId: "pi" },
        {
          threadId: "claude-thread",
          owner: "external" as const,
          harnessId: "claude-code",
        },
      ],
    };

    expect(threadOwnershipListParamsSchema.parse(params)).toEqual(params);
    expect(threadOwnershipListResultSchema.parse(result)).toEqual(result);
    for (const invalid of [
      { threadIds: [] },
      { threadIds: ["thread-1", "thread-1"] },
      {
        threadIds: Array.from(
          { length: THREAD_OWNERSHIP_LIST_MAX_LENGTH + 1 },
          (_, index) => `thread-${index}`,
        ),
      },
      { threadIds: ["thread-1"], nativeMethod: "get_entries" },
    ]) {
      expect(threadOwnershipListParamsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      threadOwnershipListResultSchema.safeParse({
        threads: [
          {
            threadId: "pi-thread",
            owner: "external",
            harnessId: "pi",
            nativeSessionRef: { nativeSessionId: "private" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      threadOwnershipListResultSchema.safeParse({
        threads: [
          { threadId: "thread-1", owner: "codex" },
          { threadId: "thread-1", owner: "codex" },
        ],
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
