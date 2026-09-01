import { describe, expect, it } from "vitest";

import {
  HARNESS_PERMISSION_MODE_ID_MAX_LENGTH,
  harnessConfigurationStateSchema,
  harnessInspectionSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  permissionModeFixedAtCreate,
  threadPermissionModeSelectParamsSchema,
} from "@codexhost/shared-contracts";

const permissionModes = {
  modes: [
    { id: "default", label: "Default" },
    {
      id: "bypassPermissions",
      label: "Bypass permissions",
      description: "Skip native permission checks.",
      dangerous: true,
    },
  ],
  defaultModeId: "default",
};

function readyInspection(selectPermissionMode: boolean) {
  return {
    status: "ready" as const,
    catalog: { models: [], thinkingOptions: [] },
    ...(selectPermissionMode ? { permissionModes } : {}),
    capabilities: {
      configuration: {
        selectModel: false,
        selectThinkingOption: false,
        selectPermissionMode,
        permissionModeScope: "live" as const,
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
}

describe("Harness Permission Mode runtime contracts", () => {
  it("accepts a finite opaque catalog and effective configuration state", () => {
    expect(harnessPermissionModeCatalogSchema.parse(permissionModes)).toEqual(permissionModes);
    expect(harnessInspectionSchema.parse(readyInspection(true))).toEqual(readyInspection(true));
    expect(harnessConfigurationStateSchema.parse({ effectivePermissionModeId: "default" })).toEqual(
      { effectivePermissionModeId: "default" },
    );
    expect(
      threadPermissionModeSelectParamsSchema.parse({
        threadId: "thread-1",
        permissionModeId: "bypassPermissions",
      }),
    ).toEqual({ threadId: "thread-1", permissionModeId: "bypassPermissions" });
  });

  it("defaults Permission Mode scope to live and treats atCreate as fixed", () => {
    const parsed = harnessInspectionSchema.parse({
      ...readyInspection(true),
      capabilities: {
        configuration: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: true,
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    });
    if (parsed.status !== "ready") throw new Error("Inspection is not ready");
    expect(parsed.capabilities.configuration.permissionModeScope).toBe("live");
    expect(permissionModeFixedAtCreate(parsed.capabilities.configuration)).toBe(false);
    expect(permissionModeFixedAtCreate({ permissionModeScope: "atCreate" })).toBe(true);
    expect(
      harnessInspectionSchema.parse({
        ...readyInspection(true),
        capabilities: {
          configuration: {
            selectModel: false,
            selectThinkingOption: false,
            selectPermissionMode: true,
            permissionModeScope: "atCreate",
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      }),
    ).toMatchObject({
      capabilities: { configuration: { permissionModeScope: "atCreate" } },
    });
  });

  it("requires catalog and structural capability to agree", () => {
    expect(
      harnessInspectionSchema.safeParse({
        ...readyInspection(false),
        permissionModes,
      }).success,
    ).toBe(false);
    const missingCatalog = readyInspection(true) as Record<string, unknown>;
    delete missingCatalog.permissionModes;
    expect(harnessInspectionSchema.safeParse(missingCatalog).success).toBe(false);
  });

  it("rejects duplicate, missing-default, unsafe, unbounded, and extended values", () => {
    expect(
      harnessPermissionModeCatalogSchema.safeParse({
        modes: [
          { id: "default", label: "Default" },
          { id: "default", label: "Duplicate" },
        ],
        defaultModeId: "default",
      }).success,
    ).toBe(false);
    expect(
      harnessPermissionModeCatalogSchema.safeParse({
        modes: [{ id: "default", label: "Default" }],
        defaultModeId: "missing",
      }).success,
    ).toBe(false);
    expect(harnessPermissionModeIdSchema.safeParse("provider/mode").success).toBe(false);
    expect(
      harnessPermissionModeIdSchema.safeParse(
        `m${"x".repeat(HARNESS_PERMISSION_MODE_ID_MAX_LENGTH)}`,
      ).success,
    ).toBe(false);
    expect(
      threadPermissionModeSelectParamsSchema.safeParse({
        threadId: "thread-1",
        permissionModeId: "default",
        nativeMode: "dontAsk",
      }).success,
    ).toBe(false);
  });
});
