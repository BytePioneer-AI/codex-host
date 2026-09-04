import { describe, expect, it } from "vitest";

import {
  loadModernModelCatalog,
  ModernModelCatalogError,
  parseModernModelCatalog,
  type ModernModelCatalogRemote,
} from "../../src/modern/catalog.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteConnectionErrorCode,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

function catalogValue(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    default: { provider: "provider-1", model: "model-1", reasoningEffort: "high" },
    routableProviders: ["provider-2", "provider-1", "empty-provider"],
    groups: [
      {
        id: "provider-2",
        name: "Second",
        models: [{ id: "model-2", name: "Model Two", description: "not in CH contract" }],
      },
      {
        id: "provider-1",
        name: "First",
        models: [
          {
            id: "model-1",
            name: "Model One",
            description: "real Modern models carry descriptions",
            reasoning: {
              efforts: [
                { id: "off", name: "Off", description: "No reasoning" },
                { id: "high", name: "High" },
              ],
              defaultEffort: "high",
            },
          },
        ],
      },
    ],
    failures: [],
    ...overrides,
  };
}

class FakeRemote implements ModernModelCatalogRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(
    readonly result: ModernRemoteResult<unknown> | Error = {
      ok: true,
      value: catalogValue(),
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

describe("DeepSeek Harness Modern Model catalog", () => {
  it("calls the no-argument endpoint and preserves provider, Model, and effort order", async () => {
    const remote = new FakeRemote();
    const snapshot = await loadModernModelCatalog(remote);

    expect(remote.calls).toEqual([{ endpoint: "session/modelCatalog", args: {} }]);
    expect(snapshot.routableProviders).toEqual(["provider-2", "provider-1", "empty-provider"]);
    expect(snapshot.groups.map(({ id }) => id)).toEqual(["provider-2", "provider-1"]);
    expect(snapshot.catalog.models.map(({ label }) => label)).toEqual([
      "Second / Model Two",
      "First / Model One",
    ]);
    expect(snapshot.catalog.models[1]).not.toHaveProperty("description");
    expect(snapshot.catalog.thinkingOptions).toEqual([
      { id: "off", label: "Off" },
      { id: "high", label: "High" },
    ]);
    expect(snapshot.catalog.defaultThinkingOptionId).toBe("high");
    expect(snapshot.catalog.defaultModel).toEqual(snapshot.catalog.models[1]?.ref);
  });

  it("validates then discards isolated provider failure messages", () => {
    const canary = "PROVIDER_FAILURE_SECRET_CANARY";
    const snapshot = parseModernModelCatalog(
      catalogValue({
        failures: [{ id: "empty-provider", name: "Empty", message: canary }],
      }),
    );

    expect(snapshot.catalog.models).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain(canary);
  });

  it("does not invent a Harness default when the Modern default is not routable", () => {
    const snapshot = parseModernModelCatalog(
      catalogValue({ default: { provider: "offline-provider", model: "offline-model" } }),
    );

    expect(snapshot.defaultSelection).toEqual({
      provider: "offline-provider",
      model: "offline-model",
    });
    expect(snapshot.catalog.defaultModel).toBeUndefined();
    expect(snapshot.catalog.models.map(({ label }) => label)).toEqual([
      "Second / Model Two",
      "First / Model One",
    ]);
  });

  it.each([
    ["unlisted", catalogValue({ default: { provider: "provider-1", model: "unlisted-model" } })],
    [
      "empty-provider",
      catalogValue({ default: { provider: "empty-provider", model: "default-model" } }),
    ],
    [
      "failed-provider",
      catalogValue({
        default: { provider: "empty-provider", model: "default-model" },
        failures: [{ id: "empty-provider", name: "Empty", message: "catalog failed" }],
      }),
    ],
  ])("publishes a routable %s default even without a listed Model", (_label, value) => {
    const snapshot = parseModernModelCatalog(value);

    expect(snapshot.catalog.defaultModel).toEqual(snapshot.catalog.models[0]?.ref);
  });

  it("accepts a stale default reasoning effort without advertising it", () => {
    const snapshot = parseModernModelCatalog(
      catalogValue({
        default: { provider: "provider-1", model: "model-1", reasoningEffort: "stale" },
      }),
    );

    expect(snapshot.catalog.defaultModel).toBeDefined();
    expect(snapshot.catalog.defaultThinkingOptionId).toBeUndefined();
  });

  it.each([
    ["an extra result field", { extra: true }],
    ["duplicate routable providers", { routableProviders: ["provider-1", "provider-1"] }],
    [
      "duplicate provider groups",
      {
        groups: [
          { id: "provider-1", name: "One", models: [{ id: "a", name: "A" }] },
          { id: "provider-1", name: "One", models: [{ id: "b", name: "B" }] },
        ],
      },
    ],
    [
      "duplicate Model ids",
      {
        groups: [
          {
            id: "provider-1",
            name: "One",
            models: [
              { id: "same", name: "A" },
              { id: "same", name: "B" },
            ],
          },
        ],
      },
    ],
    [
      "duplicate efforts",
      {
        groups: [
          {
            id: "provider-1",
            name: "One",
            models: [
              {
                id: "model-1",
                name: "One",
                reasoning: {
                  efforts: [
                    { id: "high", name: "High" },
                    { id: "high", name: "Again" },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseModernModelCatalog(catalogValue(overrides))).toThrowError(
      ModernModelCatalogError,
    );
  });

  it("enforces a finite provider bound", () => {
    expect(() =>
      parseModernModelCatalog(
        catalogValue({
          default: { provider: "offline", model: "offline" },
          routableProviders: Array.from({ length: 257 }, (_, index) => `provider-${index}`),
          groups: [],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "limitExceeded" }));
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
    ModernModelCatalogError["code"],
  ])[])("preserves connection error %s as %s", async (sourceCode, expectedCode) => {
    const canary = "CATALOG_CONNECTION_SECRET_CANARY";
    const source = new ModernRemoteConnectionError(
      sourceCode,
      `secret=${canary}`,
      `api_key=${canary}`,
    );
    Object.defineProperty(source, "cause", { enumerable: true, value: new Error(canary) });

    const failure = await loadModernModelCatalog(new FakeRemote(source)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: expectedCode,
      nativeCode: "api_key=[redacted]",
    });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("sanitizes Remote failures and never retains an unexpected cause", async () => {
    const canary = "CATALOG_REMOTE_SECRET_CANARY";
    const remoteFailure = new FakeRemote({
      ok: false,
      error: {
        code: `api_key=${canary}`,
        message: `secret=${canary}`,
        details: { secret: canary },
      },
    });
    const structured = await loadModernModelCatalog(remoteFailure).catch((error: unknown) => error);
    expect(structured).toMatchObject({ code: "remoteError", nativeCode: "api_key=[redacted]" });
    expect(JSON.stringify(structured)).not.toContain(canary);

    const thrown = await loadModernModelCatalog(
      new FakeRemote(new Error(`api_key=${canary}`, { cause: new Error(canary) })),
    ).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: "unavailable" });
    expect((thrown as Error).cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain(canary);
  });
});
