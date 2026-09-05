import { describe, expect, it, vi } from "vitest";

import {
  harnessPermissionModeCatalogSchema,
  nativeSessionRefSchema,
  type HarnessPermissionModeCatalog,
} from "@codexhost/shared-contracts";

import { decodeDeepSeekHarnessModelRef } from "../../src/model-catalog.js";
import { parseModernModelCatalog } from "../../src/modern/catalog.js";
import {
  MODERN_MODEL_SELECTION_PROJECTION_KEY,
  MODERN_PERMISSION_PROJECTION_KEY,
  ModernConfigurationError,
  readModernConfigurationSnapshot,
  selectModernModel,
  selectModernPermissionMode,
  type ModernConfigurationControl,
  type ModernConfigurationRemote,
} from "../../src/modern/configuration.js";
import {
  ModernControlStoreError,
  type ModernControlJsonValue,
  type ModernProjectionRow,
} from "../../src/modern/control-store.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const SESSION_ID = "session-1";

function modelCatalog() {
  return parseModernModelCatalog({
    default: { provider: "provider-1", model: "model-1", reasoningEffort: "high" },
    routableProviders: ["provider-1", "empty-provider"],
    groups: [
      {
        id: "provider-1",
        name: "Provider One",
        models: [
          {
            id: "model-1",
            name: "Model One",
            reasoning: {
              efforts: [
                { id: "off", name: "Off" },
                { id: "high", name: "High" },
              ],
              defaultEffort: "high",
            },
          },
        ],
      },
    ],
    failures: [],
  });
}

function permissionCatalog(): HarnessPermissionModeCatalog {
  return harnessPermissionModeCatalogSchema.parse({
    modes: [
      { id: "ask", label: "Ask" },
      { id: "danger-full-access", label: "Full Access" },
    ],
    defaultModeId: "ask",
  });
}

function modelValue(
  next: { provider: string; model: string; reasoningEffort?: string } | null,
): ModernControlJsonValue {
  return { lastUsed: null, next } as ModernControlJsonValue;
}

function permissionValue(currentValue: string): ModernControlJsonValue {
  return {
    options: [
      { value: "ask", name: "Ask" },
      { value: "danger-full-access", name: "Full Access" },
    ],
    currentValue,
  };
}

interface PendingWait {
  readonly key: string;
  readonly afterSeq: number;
  readonly predicate: (value: ModernControlJsonValue) => boolean;
  readonly resolve: (row: ModernProjectionRow) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

class FakeControl implements ModernConfigurationControl {
  readonly waitCalls: Array<{ readonly key: string; readonly afterSeq: number }> = [];
  readonly #rows: Record<string, ModernProjectionRow> = {};
  readonly #waits = new Set<PendingWait>();

  constructor(rows: Readonly<Record<string, ModernProjectionRow>> = {}) {
    Object.assign(this.#rows, rows);
  }

  snapshot(sessionId: string): Readonly<Record<string, ModernProjectionRow>> | undefined {
    return sessionId === SESSION_ID ? this.#rows : undefined;
  }

  set(key: string, value: ModernControlJsonValue, seq: number): void {
    const row = { value, seq };
    this.#rows[key] = row;
    for (const wait of [...this.#waits]) {
      if (wait.key !== key || seq <= wait.afterSeq || !wait.predicate(value)) continue;
      this.#settle(wait);
      wait.resolve(row);
    }
  }

  waitFor(
    sessionId: string,
    key: string,
    afterSeq: number,
    predicate: (value: ModernControlJsonValue) => boolean,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ModernProjectionRow> {
    this.waitCalls.push({ key, afterSeq });
    if (sessionId !== SESSION_ID) {
      return Promise.reject(new ModernControlStoreError("detached", "Session is detached"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ModernControlStoreError("cancelled", "Wait was cancelled"));
    }
    const existing = this.#rows[key];
    if (existing && existing.seq > afterSeq && predicate(existing.value)) {
      return Promise.resolve(existing);
    }
    return new Promise<ModernProjectionRow>((resolve, reject) => {
      const wait: PendingWait = {
        key,
        afterSeq,
        predicate,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        wait.onAbort = () => {
          this.#settle(wait);
          reject(new ModernControlStoreError("cancelled", "Wait was cancelled"));
        };
        options.signal.addEventListener("abort", wait.onAbort, { once: true });
      }
      this.#waits.add(wait);
    });
  }

  #settle(wait: PendingWait): void {
    this.#waits.delete(wait);
    if (wait.signal && wait.onAbort) wait.signal.removeEventListener("abort", wait.onAbort);
  }
}

type RemoteHandler = (
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  options?: { readonly timeoutMs?: number | null },
) => Promise<ModernRemoteResult<unknown>>;

class FakeRemote implements ModernConfigurationRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
    readonly options?: { readonly timeoutMs?: number | null };
  }> = [];

  constructor(readonly handler: RemoteHandler) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: { readonly timeoutMs?: number | null },
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({
      endpoint,
      args,
      ...(signal ? { signal } : {}),
      ...(options ? { options } : {}),
    });
    return this.handler(endpoint, args, signal, options) as Promise<ModernRemoteResult<T>>;
  }
}

function initialControl(): FakeControl {
  return new FakeControl({
    [MODERN_MODEL_SELECTION_PROJECTION_KEY]: {
      value: modelValue({
        provider: "provider-1",
        model: "model-1",
        reasoningEffort: "high",
      }),
      seq: 3,
    },
    [MODERN_PERMISSION_PROJECTION_KEY]: { value: permissionValue("ask"), seq: 4 },
  });
}

describe("DeepSeek Harness Modern configuration projection", () => {
  it("merges authoritative Model and Permission rows into one Session state", () => {
    const catalog = modelCatalog();
    const snapshot = readModernConfigurationSnapshot({
      control: initialControl(),
      sessionId: SESSION_ID,
      nativeRef: nativeSessionRefSchema.parse({
        formatVersion: 1,
        harnessId: "deepseek-harness",
        nativeSessionId: SESSION_ID,
      }),
      modelCatalog: catalog,
      permissionModes: permissionCatalog(),
    });

    expect(snapshot.state).toEqual({
      nativeRef: {
        formatVersion: 1,
        harnessId: "deepseek-harness",
        nativeSessionId: SESSION_ID,
      },
      effectiveModel: catalog.catalog.models[0]?.ref,
      resolvedModelLabel: "Provider One / Model One",
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      effectivePermissionModeId: "ask",
    });
  });

  it.each([
    ["listed provider", "provider-1", "unlisted-model"],
    ["empty routable provider", "empty-provider", "provider-default"],
  ])(
    "preserves a %s opaque Model without inventing labels or Thinking options",
    (_, provider, model) => {
      const catalog = modelCatalog();
      const control = initialControl();
      control.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue({ provider, model }), 5);

      const snapshot = readModernConfigurationSnapshot({
        control,
        sessionId: SESSION_ID,
        nativeRef: nativeSessionRefSchema.parse({
          formatVersion: 1,
          harnessId: "deepseek-harness",
          nativeSessionId: SESSION_ID,
        }),
        modelCatalog: catalog,
        permissionModes: permissionCatalog(),
      });

      if (!snapshot.state.effectiveModel) throw new Error("Expected an effective Model");
      expect(decodeDeepSeekHarnessModelRef(snapshot.state.effectiveModel)).toEqual({
        provider,
        model,
      });
      expect(snapshot.state).not.toHaveProperty("resolvedModelLabel");
      expect(snapshot.state).not.toHaveProperty("availableThinkingOptions");
    },
  );

  it("rejects a projection whose provider is not routable", () => {
    const control = initialControl();
    control.set(
      MODERN_MODEL_SELECTION_PROJECTION_KEY,
      modelValue({ provider: "unknown-provider", model: "model-1" }),
      5,
    );

    expect(() =>
      readModernConfigurationSnapshot({
        control,
        sessionId: SESSION_ID,
        nativeRef: nativeSessionRefSchema.parse({
          formatVersion: 1,
          harnessId: "deepseek-harness",
          nativeSessionId: SESSION_ID,
        }),
        modelCatalog: modelCatalog(),
        permissionModes: permissionCatalog(),
      }),
    ).toThrowError(ModernConfigurationError);
  });

  it("preserves an authoritative stale effort without publishing a contradictory option list", () => {
    const control = initialControl();
    control.set(
      MODERN_MODEL_SELECTION_PROJECTION_KEY,
      modelValue({ provider: "provider-1", model: "model-1", reasoningEffort: "stale" }),
      5,
    );

    const snapshot = readModernConfigurationSnapshot({
      control,
      sessionId: SESSION_ID,
      nativeRef: nativeSessionRefSchema.parse({
        formatVersion: 1,
        harnessId: "deepseek-harness",
        nativeSessionId: SESSION_ID,
      }),
      modelCatalog: modelCatalog(),
      permissionModes: permissionCatalog(),
    });

    expect(snapshot.state.effectiveThinkingOptionId).toBe("stale");
    expect(snapshot.state).not.toHaveProperty("availableThinkingOptions");
  });

  it("projects the listed Model default effort when the selection omits one", () => {
    const control = initialControl();
    control.set(
      MODERN_MODEL_SELECTION_PROJECTION_KEY,
      modelValue({ provider: "provider-1", model: "model-1" }),
      5,
    );

    const snapshot = readModernConfigurationSnapshot({
      control,
      sessionId: SESSION_ID,
      nativeRef: nativeSessionRefSchema.parse({
        formatVersion: 1,
        harnessId: "deepseek-harness",
        nativeSessionId: SESSION_ID,
      }),
      modelCatalog: modelCatalog(),
      permissionModes: permissionCatalog(),
    });

    expect(snapshot.state.effectiveThinkingOptionId).toBe("high");
    expect(snapshot.state.availableThinkingOptions).toEqual([
      { id: "off", label: "Off" },
      { id: "high", label: "High" },
    ]);
  });
});

describe("DeepSeek Harness Modern Model selection", () => {
  it("pins an explicit default when the fresh projection still has no durable selection", async () => {
    const catalog = modelCatalog();
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "high" };
    const control = new FakeControl({
      [MODERN_MODEL_SELECTION_PROJECTION_KEY]: { value: modelValue(null), seq: 3 },
    });
    const remote = new FakeRemote(async () => ({
      ok: true,
      value: { selected: requested },
    }));
    const selecting = selectModernModel(remote, control, SESSION_ID, catalog, requested);

    await vi.waitFor(() =>
      expect(control.waitCalls).toContainEqual({
        key: MODERN_MODEL_SELECTION_PROJECTION_KEY,
        afterSeq: 3,
      }),
    );
    control.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 4);

    await expect(selecting).resolves.toMatchObject({ changed: true, projectionSeq: 4 });
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]).toMatchObject({
      endpoint: "session/selectModel",
      args: { request: { sessionId: SESSION_ID, ...requested } },
    });
  });

  it("waits for an authoritative initial row and short-circuits the same selection", async () => {
    const catalog = modelCatalog();
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "high" };
    const control = new FakeControl();
    const remote = new FakeRemote(async () => ({ ok: true, value: undefined }));
    const selecting = selectModernModel(remote, control, SESSION_ID, catalog, requested);

    await vi.waitFor(() =>
      expect(control.waitCalls).toEqual([
        { key: MODERN_MODEL_SELECTION_PROJECTION_KEY, afterSeq: -1 },
      ]),
    );
    control.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 0);

    await expect(selecting).resolves.toMatchObject({ changed: false, projectionSeq: 0 });
    expect(remote.calls).toEqual([]);
  });

  it("accepts both projection-before-response and response-before-projection", async () => {
    const catalog = modelCatalog();
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "off" };

    const earlyControl = initialControl();
    const earlyRemote = new FakeRemote(async () => {
      earlyControl.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 5);
      return { ok: true, value: { selected: requested } };
    });
    await expect(
      selectModernModel(earlyRemote, earlyControl, SESSION_ID, catalog, requested),
    ).resolves.toMatchObject({ changed: true, projectionSeq: 5 });

    const lateControl = initialControl();
    const lateRemote = new FakeRemote(async () => ({
      ok: true,
      value: { selected: requested },
    }));
    const selecting = selectModernModel(lateRemote, lateControl, SESSION_ID, catalog, requested);
    await vi.waitFor(() =>
      expect(lateControl.waitCalls).toContainEqual({
        key: MODERN_MODEL_SELECTION_PROJECTION_KEY,
        afterSeq: 3,
      }),
    );
    lateControl.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 6);
    await expect(selecting).resolves.toMatchObject({ changed: true, projectionSeq: 6 });
  });

  it("uses projection readback only for uncertainty and faults a contradictory reject", async () => {
    const catalog = modelCatalog();
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "off" };
    const uncertainControl = initialControl();
    const uncertainRemote = new FakeRemote(async () => {
      uncertainControl.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 5);
      throw new ModernRemoteConnectionError("unavailable", "connection dropped");
    });
    await expect(
      selectModernModel(uncertainRemote, uncertainControl, SESSION_ID, catalog, requested),
    ).resolves.toMatchObject({ changed: true, projectionSeq: 5 });

    const rejectedControl = initialControl();
    const rejectedRemote = new FakeRemote(async () => {
      rejectedControl.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, modelValue(requested), 5);
      return {
        ok: false,
        error: { code: "model/rejected", message: "rejected", details: {} },
      };
    });
    await expect(
      selectModernModel(rejectedRemote, rejectedControl, SESSION_ID, catalog, requested),
    ).rejects.toMatchObject({ code: "protocolError" });

    const plainReject = new FakeRemote(async () => ({
      ok: false,
      error: { code: "model/rejected", message: "rejected", details: {} },
    }));
    await expect(
      selectModernModel(plainReject, initialControl(), SESSION_ID, catalog, requested),
    ).rejects.toMatchObject({ code: "remoteError", nativeCode: "model/rejected" });
  });

  it("preserves a malformed matching projection as a protocol error", async () => {
    const catalog = modelCatalog();
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "off" };
    const control = initialControl();
    const remote = new FakeRemote(async () => ({ ok: true, value: { selected: requested } }));
    const selecting = selectModernModel(remote, control, SESSION_ID, catalog, requested);
    await vi.waitFor(() => expect(control.waitCalls).toHaveLength(1));
    control.set(MODERN_MODEL_SELECTION_PROJECTION_KEY, { malformed: true }, 5);

    await expect(selecting).rejects.toMatchObject({ code: "protocolError" });
  });

  it("drops untyped transport exception messages and causes", async () => {
    const secret = "CONFIGURATION_EXCEPTION_SECRET_CANARY";
    const requested = { provider: "provider-1", model: "model-1", reasoningEffort: "off" };
    const remote = new FakeRemote(async () => {
      throw new Error(secret, { cause: new Error(secret) });
    });

    const failure = await selectModernModel(
      remote,
      initialControl(),
      SESSION_ID,
      modelCatalog(),
      requested,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "unavailable" });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
});

describe("DeepSeek Harness Modern Permission selection", () => {
  it("short-circuits the same authoritative preset without a command RPC", async () => {
    const remote = new FakeRemote(async () => ({ ok: true, value: undefined }));
    await expect(
      selectModernPermissionMode(
        remote,
        initialControl(),
        SESSION_ID,
        permissionCatalog(),
        "ask" as never,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ changed: false, projectionSeq: 4 });
    expect(remote.calls).toEqual([]);
  });

  it("executes the internal command once and waits for an exact higher projection", async () => {
    const control = initialControl();
    const remote = new FakeRemote(async () => ({
      ok: true,
      value: { commandId: "command-1", result: { kind: "success" } },
    }));
    const selecting = selectModernPermissionMode(
      remote,
      control,
      SESSION_ID,
      permissionCatalog(),
      "danger-full-access" as never,
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(control.waitCalls).toContainEqual({
        key: MODERN_PERMISSION_PROJECTION_KEY,
        afterSeq: 4,
      }),
    );
    control.set(MODERN_PERMISSION_PROJECTION_KEY, permissionValue("danger-full-access"), 5);

    await expect(selecting).resolves.toEqual({ changed: true, projectionSeq: 5 });
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]).toMatchObject({
      endpoint: "commands/execute",
      args: {
        agentId: SESSION_ID,
        line: "/permission danger-full-access",
        images: [],
      },
      options: { timeoutMs: null },
    });
  });

  it("faults a command rejection that contradicts an already-higher projection", async () => {
    const control = initialControl();
    const remote = new FakeRemote(async () => {
      control.set(MODERN_PERMISSION_PROJECTION_KEY, permissionValue("danger-full-access"), 5);
      return {
        ok: false,
        error: { code: "command/rejected", message: "rejected", details: {} },
      };
    });

    await expect(
      selectModernPermissionMode(
        remote,
        control,
        SESSION_ID,
        permissionCatalog(),
        "danger-full-access" as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "protocolError" });
    expect(remote.calls).toHaveLength(1);
  });
});
