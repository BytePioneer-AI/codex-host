import { describe, expect, it } from "vitest";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import {
  isModernPermissionModeProjectionMatch,
  loadModernPermissionModeCatalog,
  ModernPermissionModeError,
  parseModernPermissionPresetCatalog,
  readModernPermissionModeState,
  type ModernPermissionModeRemote,
} from "../../src/modern/permission-modes.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteConnectionErrorCode,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";
/** The `permissionPresets/catalog` value DSH serves since 0.1.7-rc.1. */
function presetCatalog(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const options = [
    { value: "read-only", name: "Read only", description: "Read files only." },
    { value: "workspace-write", name: "workspace-write" },
    { value: "danger-full-access", name: "danger-full-access", description: "" },
  ];
  return { options, defaultOptions: options, defaultPreset: "workspace-write", ...overrides };
}

function catalog() {
  return parseModernPermissionPresetCatalog(presetCatalog());
}

class FakeRemote implements ModernPermissionModeRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(
    readonly result: ModernRemoteResult<unknown> | Error = {
      ok: true,
      value: presetCatalog(),
    },
  ) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result as ModernRemoteResult<T>);
  }
}

describe("DeepSeek Harness Modern Permission Mode boundary", () => {
  it("reads presets from the process catalog", async () => {
    const remote = new FakeRemote({ ok: true, value: presetCatalog() });
    await expect(loadModernPermissionModeCatalog(remote, undefined)).resolves.toEqual({
      modes: [
        { id: "read-only", label: "Read only", description: "Read files only." },
        { id: "workspace-write", label: "workspace-write" },
        { id: "danger-full-access", label: "danger-full-access" },
      ],
      defaultModeId: "workspace-write",
    });
    expect(remote.calls).toEqual([{ endpoint: "permissionPresets/catalog", args: {} }]);

    // A live `auto` is selectable but never a configured default.
    const auto = { value: "auto", name: "Auto" };
    const options = [...(presetCatalog().options as unknown[]), auto];
    expect(
      parseModernPermissionPresetCatalog(presetCatalog({ options }))?.modes.map(({ id }) => id),
    ).toEqual(["read-only", "workspace-write", "danger-full-access", "auto"]);
  });

  it("hides permissions only when the catalog Service is not composed", async () => {
    const failure = (code: string) =>
      new FakeRemote({ ok: false, error: { code, message: "unavailable", details: {} } });
    await expect(
      loadModernPermissionModeCatalog(failure("gateway/service-unavailable"), undefined),
    ).resolves.toBeNull();
    await expect(
      loadModernPermissionModeCatalog(failure("gateway/internal"), undefined),
    ).rejects.toMatchObject({ code: "remoteError", nativeCode: "gateway/internal" });
  });

  it.each([
    ["extra catalog keys", presetCatalog({ extra: true })],
    ["no options", presetCatalog({ options: [], defaultOptions: [] })],
    [
      "a reserved custom option",
      presetCatalog({
        options: [...(presetCatalog().options as unknown[]), { value: "custom", name: "Custom" }],
      }),
    ],
    [
      "duplicate options",
      presetCatalog({
        options: [
          { value: "workspace-write", name: "workspace-write" },
          { value: "workspace-write", name: "workspace-write" },
        ],
      }),
    ],
    ["a blank label", presetCatalog({ options: [{ value: "workspace-write", name: " " }] })],
    [
      "extra option keys",
      presetCatalog({ options: [{ value: "workspace-write", name: "w", extra: 1 }] }),
    ],
    ["an unknown default", presetCatalog({ defaultPreset: "unknown" })],
    [
      "a default that is not configured",
      presetCatalog({
        options: [...(presetCatalog().options as unknown[]), { value: "auto", name: "Auto" }],
        defaultPreset: "auto",
      }),
    ],
    [
      "defaults missing from the options",
      presetCatalog({ defaultOptions: [{ value: "workspace-write", name: "Workspace" }] }),
    ],
    ["a non-JSON value", presetCatalog({ extra: new Date(0) })],
  ])("rejects a catalog with %s", (_label, value) => {
    expect(() => parseModernPermissionPresetCatalog(value)).toThrowError(ModernPermissionModeError);
  });

  it("enforces finite catalog node, depth and option bounds", () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) deep = [deep];
    const options = Array.from({ length: 1_025 }, (_, index) => ({
      value: `preset-${index}`,
      name: `Preset ${index}`,
    }));
    for (const value of [
      presetCatalog({ extra: Array.from({ length: 200_001 }, () => 0) }),
      presetCatalog({ extra: deep }),
      presetCatalog({ options, defaultOptions: options, defaultPreset: "preset-0" }),
    ]) {
      expect(() => parseModernPermissionPresetCatalog(value)).toThrowError(
        expect.objectContaining({ code: "limitExceeded" }),
      );
    }
  });

  it("reads a current-only projection, including custom and a later auto", () => {
    const read = (currentValue: string, seq = 3) =>
      readModernPermissionModeState({ value: { currentValue }, seq }, catalog());
    expect(read("danger-full-access")).toEqual({
      permissionModeId: "danger-full-access",
      projectionSeq: 3,
    });
    expect(read("workspace-write", -1)).toEqual({
      permissionModeId: "workspace-write",
      projectionSeq: -1,
    });
    expect(read("custom")?.permissionModeId).toBe("custom");
    expect(read("auto")?.permissionModeId).toBe("auto");
    expect(() => read("unknown")).toThrowError(ModernPermissionModeError);
    expect(
      isModernPermissionModeProjectionMatch(
        { currentValue: "read-only" },
        catalog(),
        harnessPermissionModeIdSchema.parse("read-only"),
      ),
    ).toBe(true);
    expect(
      isModernPermissionModeProjectionMatch(
        { currentValue: "read-only" },
        catalog(),
        harnessPermissionModeIdSchema.parse("workspace-write"),
      ),
    ).toBe(false);
    // `custom` is never a selectable target.
    expect(() =>
      isModernPermissionModeProjectionMatch(
        { currentValue: "custom" },
        catalog(),
        harnessPermissionModeIdSchema.parse("custom"),
      ),
    ).toThrowError(TypeError);
  });

  it.each([
    ["missing", undefined],
    [
      "retired pre-V4",
      {
        value: {
          options: [{ value: "workspace-write", name: "workspace-write" }],
          currentValue: "workspace-write",
        },
        seq: 1,
      },
    ],
    ["non-string current", { value: { currentValue: 42 }, seq: 1 }],
    ["invalid sequence", { value: { currentValue: "workspace-write" }, seq: -2 }],
    ["negative zero sequence", { value: { currentValue: "workspace-write" }, seq: -0 }],
  ])("fails closed on a %s permissions row", (_label, row) => {
    expect(() => readModernPermissionModeState(row, catalog())).toThrowError(
      ModernPermissionModeError,
    );
  });

  it("fails when catalog and projection presence disagree", () => {
    expect(readModernPermissionModeState(undefined, null)).toBeUndefined();
    expect(() =>
      readModernPermissionModeState({ value: { currentValue: "workspace-write" }, seq: 1 }, null),
    ).toThrowError(ModernPermissionModeError);
  });

  it.each([
    ["protocolError", "protocolError"],
    ["authenticationRequired", "authenticationRequired"],
    ["processExited", "processExited"],
    ["notInstalled", "notInstalled"],
    ["cancelled", "cancelled"],
    ["unavailable", "unavailable"],
  ] as const satisfies readonly (readonly [
    ModernRemoteConnectionErrorCode,
    ModernPermissionModeError["code"],
  ])[])("preserves connection error %s as %s", async (sourceCode, expectedCode) => {
    const canary = "PERMISSION_CONNECTION_SECRET_CANARY";
    const source = new ModernRemoteConnectionError(
      sourceCode,
      `secret=${canary}`,
      `api_key=${canary}`,
    );
    Object.defineProperty(source, "cause", { enumerable: true, value: new Error(canary) });

    const failure = await loadModernPermissionModeCatalog(new FakeRemote(source)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: expectedCode,
      nativeCode: "api_key=[redacted]",
    });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("sanitizes Remote failures and drops raw exception causes", async () => {
    const canary = "PERMISSION_REMOTE_SECRET_CANARY";
    const structured = await loadModernPermissionModeCatalog(
      new FakeRemote({
        ok: false,
        error: {
          code: `api_key=${canary}`,
          message: `secret=${canary}`,
          details: { secret: canary },
        },
      }),
    ).catch((error: unknown) => error);
    expect(structured).toMatchObject({ code: "remoteError", nativeCode: "api_key=[redacted]" });
    expect(JSON.stringify(structured)).not.toContain(canary);

    const thrown = await loadModernPermissionModeCatalog(
      new FakeRemote(new Error(`api_key=${canary}`, { cause: new Error(canary) })),
    ).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: "unavailable" });
    expect((thrown as Error).cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain(canary);
  });
});
