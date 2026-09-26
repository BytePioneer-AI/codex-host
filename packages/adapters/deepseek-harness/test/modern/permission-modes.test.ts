import { describe, expect, it } from "vitest";

import Schema from "@deepseek-ai/schemastery";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import {
  isModernPermissionModeProjectionMatch,
  loadModernPermissionModeCatalog,
  ModernPermissionModeError,
  parseModernPermissionModeCatalog,
  parseModernPermissionPresetCatalog,
  readModernPermissionModeState,
  type ModernPermissionModeRemote,
} from "../../src/modern/permission-modes.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteConnectionErrorCode,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";
import { DEEPSEEK_V015_PROFILE, DEEPSEEK_V017_PROFILE } from "../../src/profiles/profile.js";

const V3 = DEEPSEEK_V015_PROFILE;
const V4 = DEEPSEEK_V017_PROFILE;

const PRESETS = ["read-only", "workspace-write", "danger-full-access"];

function presetOption(value: string): {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
} {
  return {
    value,
    name: value === "read-only" ? "Read only" : value,
    description: `${value} description`,
  };
}

function permissionSchema(
  presets: readonly string[] = PRESETS,
  required = true,
  extraField = false,
): unknown {
  const choices = presets.map((id) =>
    id === "read-only" ? Schema.const(id).description("Read only") : Schema.const(id),
  );
  let field = Schema.union(choices);
  if (required) field = field.required();
  return JSON.parse(
    JSON.stringify(
      Schema.object({
        defaultPreset: field,
        ...(extraField ? { extra: Schema.string() } : {}),
      }).toJSON(),
    ),
  ) as unknown;
}

function permissionNamespace(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ns: "permission",
    schema: permissionSchema(),
    value: { defaultPreset: "workspace-write" },
    base: { defaultPreset: "workspace-write" },
    user: {},
    applies: "live",
    secrets: [],
    revision: 0,
    ...overrides,
  };
}

function settingsValue(
  namespaces: readonly unknown[] = [permissionNamespace()],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { writable: true, hasDocument: true, namespaces, ...overrides };
}

/** DSH 0.1.7's `permissionPresets/catalog` value (V4). */
function presetCatalog(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const options = [
    { value: "read-only", name: "Read only", description: "Read files only." },
    { value: "workspace-write", name: "workspace-write" },
    { value: "danger-full-access", name: "danger-full-access", description: "" },
  ];
  return { options, defaultOptions: options, defaultPreset: "workspace-write", ...overrides };
}

function projection(
  currentValue = "workspace-write",
  options: readonly {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
  }[] = PRESETS.map(presetOption),
): {
  readonly options: {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
  }[];
  readonly currentValue: string;
} {
  return { options: [...options], currentValue };
}

class FakeRemote implements ModernPermissionModeRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(
    readonly result: ModernRemoteResult<unknown> | Error = {
      ok: true,
      value: settingsValue(),
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
  it("reads V4 presets from the process catalog instead of settings", async () => {
    const remote = new FakeRemote({ ok: true, value: presetCatalog() });
    await expect(loadModernPermissionModeCatalog(remote, undefined, V4)).resolves.toEqual({
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

  it("hides V4 permissions only when the catalog Service is not composed", async () => {
    const failure = (code: string) =>
      new FakeRemote({ ok: false, error: { code, message: "unavailable", details: {} } });
    await expect(
      loadModernPermissionModeCatalog(failure("gateway/service-unavailable"), undefined, V4),
    ).resolves.toBeNull();
    await expect(
      loadModernPermissionModeCatalog(failure("gateway/internal"), undefined, V4),
    ).rejects.toMatchObject({ code: "remoteError", nativeCode: "gateway/internal" });
    // Earlier formats never read the process catalog.
    await expect(
      loadModernPermissionModeCatalog(failure("gateway/service-unavailable"), undefined, V3),
    ).rejects.toMatchObject({ code: "remoteError" });
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
  ])("rejects a V4 catalog with %s", (_label, value) => {
    expect(() => parseModernPermissionPresetCatalog(value)).toThrowError(ModernPermissionModeError);
  });

  it("reads a V4 current-only projection, including custom and a later auto", () => {
    const catalog = parseModernPermissionPresetCatalog(presetCatalog());
    const read = (currentValue: string) =>
      readModernPermissionModeState({ value: { currentValue }, seq: 3 }, catalog, V4);
    expect(read("danger-full-access")).toEqual({
      permissionModeId: "danger-full-access",
      projectionSeq: 3,
    });
    expect(read("custom")?.permissionModeId).toBe("custom");
    expect(read("auto")?.permissionModeId).toBe("auto");
    expect(() => read("unknown")).toThrowError(ModernPermissionModeError);
    expect(
      isModernPermissionModeProjectionMatch(
        { currentValue: "read-only" },
        catalog,
        harnessPermissionModeIdSchema.parse("read-only"),
        V4,
      ),
    ).toBe(true);
    // Each format accepts only its own projection shape.
    expect(() =>
      readModernPermissionModeState({ value: projection(), seq: 1 }, catalog, V4),
    ).toThrowError(ModernPermissionModeError);
    expect(() =>
      readModernPermissionModeState(
        { value: { currentValue: "workspace-write" }, seq: 1 },
        parseModernPermissionModeCatalog(settingsValue()),
        V3,
      ),
    ).toThrowError(ModernPermissionModeError);
  });

  it("rehydrates the exact permission settings schema and preserves choice order", async () => {
    const remote = new FakeRemote();
    const catalog = await loadModernPermissionModeCatalog(remote);

    expect(remote.calls).toEqual([{ endpoint: "settings/describe", args: {} }]);
    expect(catalog).toEqual({
      modes: [
        { id: "read-only", label: "Read only" },
        { id: "workspace-write", label: "workspace-write" },
        { id: "danger-full-access", label: "danger-full-access" },
      ],
      defaultModeId: "workspace-write",
    });
  });

  it("returns null only when the exact response has no permission namespace", () => {
    expect(
      parseModernPermissionModeCatalog(
        settingsValue([
          {
            ns: "other",
            schema: {},
            value: {},
            applies: "restart",
            secrets: [],
            revision: 1,
          },
        ]),
      ),
    ).toBeNull();
  });

  it("accepts an empty secret path segment in an unrelated namespace", () => {
    expect(
      parseModernPermissionModeCatalog(
        settingsValue([
          {
            ns: "other",
            schema: {},
            value: {},
            applies: "restart",
            secrets: [{ path: [""], set: false }],
            revision: 1,
          },
          permissionNamespace(),
        ]),
      ),
    ).not.toBeNull();
  });

  it.each([
    ["extra response keys", settingsValue(undefined, { extra: true })],
    [
      "duplicate permission namespaces",
      settingsValue([permissionNamespace(), permissionNamespace({ revision: 1 })]),
    ],
    ["restart application", settingsValue([permissionNamespace({ applies: "restart" })])],
    [
      "declared secrets",
      settingsValue([permissionNamespace({ secrets: [{ path: ["defaultPreset"], set: true }] })]),
    ],
    [
      "an optional default",
      settingsValue([permissionNamespace({ schema: permissionSchema(PRESETS, false) })]),
    ],
    [
      "a reserved custom choice",
      settingsValue([permissionNamespace({ schema: permissionSchema([...PRESETS, "custom"]) })]),
    ],
    [
      "duplicate choices",
      settingsValue([
        permissionNamespace({
          schema: permissionSchema(["read-only", "workspace-write", "workspace-write"]),
        }),
      ]),
    ],
    [
      "an unknown default",
      settingsValue([permissionNamespace({ value: { defaultPreset: "unknown" } })]),
    ],
    [
      "extra schema fields",
      settingsValue([permissionNamespace({ schema: permissionSchema(PRESETS, true, true) })]),
    ],
    [
      "extra value fields",
      settingsValue([
        permissionNamespace({ value: { defaultPreset: "workspace-write", extra: true } }),
      ]),
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseModernPermissionModeCatalog(value)).toThrowError(ModernPermissionModeError);
  });

  it("reads normal and current-only custom projections with their watermark", () => {
    const catalog = parseModernPermissionModeCatalog(settingsValue());
    if (!catalog) throw new Error("expected permission catalog");

    expect(readModernPermissionModeState({ value: projection(), seq: 12 }, catalog, V3)).toEqual({
      permissionModeId: "workspace-write",
      projectionSeq: 12,
    });
    expect(readModernPermissionModeState({ value: projection(), seq: -1 }, catalog, V3)).toEqual({
      permissionModeId: "workspace-write",
      projectionSeq: -1,
    });

    const custom = projection("custom", [
      ...PRESETS.map(presetOption),
      { value: "custom", name: "Custom" },
    ]);
    expect(readModernPermissionModeState({ value: custom, seq: 13 }, catalog, V3)).toEqual({
      permissionModeId: "custom",
      projectionSeq: 13,
    });
    expect(() =>
      isModernPermissionModeProjectionMatch(
        custom,
        catalog,
        harnessPermissionModeIdSchema.parse("custom"),
        V3,
      ),
    ).toThrowError(TypeError);
    expect(
      isModernPermissionModeProjectionMatch(
        projection("read-only"),
        catalog,
        harnessPermissionModeIdSchema.parse("workspace-write"),
        V3,
      ),
    ).toBe(false);
  });

  it.each([
    ["missing", undefined],
    [
      "reordered",
      {
        value: projection("workspace-write", [
          { value: "workspace-write", name: "workspace-write" },
          { value: "read-only", name: "Read only" },
          { value: "danger-full-access", name: "danger-full-access" },
        ]),
        seq: 1,
      },
    ],
    [
      "non-current custom",
      {
        value: projection("workspace-write", [
          ...PRESETS.map(presetOption),
          { value: "custom", name: "Custom" },
        ]),
        seq: 1,
      },
    ],
    ["invalid sequence", { value: projection(), seq: -2 }],
  ])("fails closed on a %s permissions row", (_label, row) => {
    const catalog = parseModernPermissionModeCatalog(settingsValue());
    expect(() => readModernPermissionModeState(row, catalog, V3)).toThrowError(
      ModernPermissionModeError,
    );
  });

  it.each([
    ["V3", V3, projection()],
    ["V4", V4, { currentValue: "workspace-write" }],
  ])("fails when %s catalog and projection presence disagree", (_name, profile, value) => {
    expect(readModernPermissionModeState(undefined, null, profile)).toBeUndefined();
    expect(() => readModernPermissionModeState({ value, seq: 1 }, null, profile)).toThrowError(
      ModernPermissionModeError,
    );
  });

  it("requires projection option names to match the inspected catalog", () => {
    const catalog = parseModernPermissionModeCatalog(settingsValue());
    if (!catalog) throw new Error("expected permission catalog");
    const mismatched = projection("workspace-write", [
      { value: "read-only", name: "read-only" },
      ...PRESETS.slice(1).map(presetOption),
    ]);

    expect(() =>
      readModernPermissionModeState({ value: mismatched, seq: 1 }, catalog, V3),
    ).toThrowError(ModernPermissionModeError);
  });

  it("accepts and ignores an empty projection option description", () => {
    const catalog = parseModernPermissionModeCatalog(settingsValue());
    if (!catalog) throw new Error("expected permission catalog");
    const withEmptyDescription = projection("workspace-write", [
      { value: "read-only", name: "Read only", description: "" },
      ...PRESETS.slice(1).map(presetOption),
    ]);

    expect(
      readModernPermissionModeState({ value: withEmptyDescription, seq: 2 }, catalog, V3),
    ).toEqual({ permissionModeId: "workspace-write", projectionSeq: 2 });
  });

  it("enforces a finite namespace bound", () => {
    const namespaces = Array.from({ length: 513 }, (_, index) => ({
      ns: `namespace-${index}`,
      schema: {},
      value: {},
      applies: "restart",
      secrets: [],
      revision: 0,
    }));
    expect(() => parseModernPermissionModeCatalog(settingsValue(namespaces))).toThrowError(
      expect.objectContaining({ code: "limitExceeded" }),
    );
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
