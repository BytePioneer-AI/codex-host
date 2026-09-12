import { setImmediate as waitImmediate } from "node:timers/promises";

import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, type DeepSeekModernSessionCandidate } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeepSeekHarnessAdapter } from "../src/deepseek-harness-adapter.js";
import {
  classifyDeepSeekVersionOutput,
  DeepSeekGenerationProbeError,
  type DeepSeekExecutableGeneration,
} from "../src/generation-selector.js";

const readyInspection: HarnessInspection = {
  status: "ready",
  catalog: { models: [], thinkingOptions: [] },
  capabilities: {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

const modernExecutable: DeepSeekExecutableGeneration = {
  generation: "modern",
  version: "0.1.2-rc.1",
  command: { command: "resolved-dsh", arguments: ["--offline"], kind: "npx" },
};

const MODERN_AUTHENTICATION_BODY =
  "dsh web authentication required; reopen the URL printed by dsh web.\n";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeAdapter implements HarnessAdapter {
  readonly harnessId = harnessIdSchema.parse("deepseek-harness");
  inspectCalls = 0;
  openCalls = 0;
  closeCalls = 0;
  listCalls = 0;

  constructor(
    readonly inspectResult: (input?: InspectHarnessInput) => Promise<HarnessInspection> = () =>
      Promise.resolve(readyInspection),
    readonly closeResult: () => Promise<void> = () => Promise.resolve(),
  ) {}

  inspect(input?: InspectHarnessInput): Promise<HarnessInspection> {
    this.inspectCalls += 1;
    return this.inspectResult(input);
  }

  async open(): Promise<HarnessResult<HarnessSession>> {
    this.openCalls += 1;
    return { ok: true, value: {} as HarnessSession };
  }

  readonly sessionImport = {
    listCandidates: async (): Promise<HarnessResult<DeepSeekModernSessionCandidate[]>> => {
      this.listCalls += 1;
      return { ok: true, value: [] };
    },
  };

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeResult();
  }
}

const unavailableInspection: HarnessInspection = {
  status: "unavailable",
  error: {
    code: "unavailable",
    message: "DeepSeek Harness managed Web is unavailable",
    retryable: true,
  },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("DeepSeek public generation selector", () => {
  it("forwards Session discovery only to the selected Modern generation", async () => {
    const modern = new FakeAdapter();
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter: () => modern,
      },
    );

    await expect(adapter.sessionImport.listCandidates()).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(modern.listCalls).toBe(1);
    await adapter.close();
  });

  it.each(["0.1.2-rc.1", "0.1.5-rc.1"] as const)(
    "revalidates import metadata and preserves %s native identity",
    async (version) => {
      const modern = new FakeAdapter();
      const list = vi
        .spyOn(modern.sessionImport, "listCandidates")
        .mockResolvedValueOnce({
          ok: true,
          value: [
            {
              nativeSessionId: "native",
              cwd: "/project",
              title: "Fresh",
              updatedAt: 1,
              running: true,
            },
          ],
        })
        .mockResolvedValueOnce({ ok: true, value: [] });
      const adapter = new DeepSeekHarnessAdapter(
        {},
        {
          probeExecutable: () => Promise.resolve({ ...modernExecutable, version }),
          createModernAdapter: () => modern,
        },
      );
      expect(await adapter.sessionImport.resolveCandidate("native")).toEqual({
        ok: true,
        value: {
          candidate: {
            nativeSessionId: "native",
            cwd: "/project",
            title: "Fresh",
            updatedAt: 1,
            running: true,
          },
          nativeRef: {
            harnessId: "deepseek-harness",
            nativeSessionId: "native",
            formatVersion: 1,
            ...(version === "0.1.5-rc.1" ? { locator: { dshVersion: version } } : {}),
          },
        },
      });
      expect(await adapter.sessionImport.resolveCandidate("native")).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
      expect(list).toHaveBeenCalledTimes(2);
      await adapter.close();
    },
  );

  it.each(["0.1.2-rc.1", "0.1.5-rc.1"] as const)(
    "passes exact %s through the managed Modern Adapter factory",
    async (version) => {
      const executable = { ...modernExecutable, version };
      const modernDelegate = new FakeAdapter();
      const createModernAdapter = vi.fn(() => modernDelegate);
      const adapter = new DeepSeekHarnessAdapter(
        {},
        {
          probeExecutable: () => Promise.resolve(executable),
          createModernAdapter,
        },
      );

      await expect(adapter.inspect()).resolves.toBe(readyInspection);
      expect(createModernAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          command: executable.command.command,
          commandArguments: executable.command.arguments,
          version,
        }),
      );
      await adapter.close();
      expect(modernDelegate.closeCalls).toBe(1);
    },
  );

  it("forwards the Host-owned Web handoff only to the selected Modern Adapter", async () => {
    const handoff = vi.fn<(url: URL) => Promise<void>>(() => Promise.resolve());
    const open = vi.fn<() => Promise<HarnessResult<void>>>(() =>
      Promise.resolve({ ok: true, value: undefined }),
    );
    const webReady = { ...readyInspection, webUi: { open: true as const } };
    const modernDelegate = Object.assign(new FakeAdapter(() => Promise.resolve(webReady)), {
      webUi: { open },
    });
    const createModernAdapter = vi.fn(() => modernDelegate);
    const adapter = new DeepSeekHarnessAdapter(
      { openWebUi: handoff },
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter,
      },
    );

    await expect(adapter.inspect()).resolves.toBe(webReady);
    expect(createModernAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ openWebUi: handoff }),
    );
    await expect(adapter.webUi.open()).resolves.toEqual({ ok: true, value: undefined });
    expect(open).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it.each(["0.1.1-rc.2", "0.1.3-rc.1", "0.1.5-rc.2", "0.1.5"])(
    "rejects unsupported %s before touching an endpoint",
    async (version) => {
      const createModernAdapter = vi.fn();
      const adapter = new DeepSeekHarnessAdapter(
        {},
        {
          probeExecutable: async () => ({
            ...classifyDeepSeekVersionOutput(version),
            command: modernExecutable.command,
          }),
          createModernAdapter,
        },
      );

      await expect(adapter.inspect()).resolves.toMatchObject({
        status: "unavailable",
        error: {
          code: "unsupported",
          retryable: false,
          stage: "version",
          durationMs: expect.any(Number),
          message: expect.stringContaining("仅支持 dsh-v0.1.2-rc.1 和 dsh-v0.1.5-rc.1"),
        },
      });
      await expect(adapter.sessionImport.resolveCandidate("native")).resolves.toMatchObject({
        ok: false,
        error: { code: "unsupported" },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(createModernAdapter).not.toHaveBeenCalled();
      await adapter.close();
    },
  );

  it("never retries a version probe whose process cleanup was not confirmed", async () => {
    const probeExecutable = vi.fn(() =>
      Promise.reject(
        new DeepSeekGenerationProbeError(
          "processExited",
          "DeepSeek Harness version process cleanup did not complete",
          { cleanupFailed: true, retryable: false },
        ),
      ),
    );
    const adapter = new DeepSeekHarnessAdapter({}, { probeExecutable });

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "processExited", retryable: false, stage: "version" },
    });
    await expect(adapter.inspect({ refresh: true })).resolves.toMatchObject({
      error: { code: "processExited", retryable: false },
    });
    expect(probeExecutable).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("rejects an external bootstrap URL without probing or echoing its token", async () => {
    const probeExecutable = vi.fn();
    const adapter = new DeepSeekHarnessAdapter(
      { endpoint: "http://127.0.0.1:3080/?token=secret-canary" },
      { probeExecutable },
    );

    const inspection = await adapter.inspect();
    expect(inspection).toMatchObject({
      status: "unavailable",
      error: {
        code: "authenticationRequired",
        message: expect.stringMatching(
          /dsh-v0\.1\.2-rc\.1 或 dsh-v0\.1\.5-rc\.1[\s\S]*only these two versions are supported/u,
        ),
        stage: "wire-handshake",
      },
    });
    expect(JSON.stringify(inspection)).not.toContain("secret-canary");
    expect(probeExecutable).not.toHaveBeenCalled();
  });

  it("identifies an authenticated Modern endpoint without starting or attaching to it", async () => {
    let externalWebRunning = true;
    const fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!externalWebRunning) return Promise.reject(new TypeError("fetch failed"));
      if (url.pathname === "/") {
        expect(init).toMatchObject({
          method: "GET",
          credentials: "omit",
          redirect: "manual",
          signal: expect.any(AbortSignal),
        });
      }
      return Promise.resolve(
        url.pathname === "/"
          ? new Response(MODERN_AUTHENTICATION_BODY, {
              status: 401,
              headers: {
                "cache-control": "no-store",
                "content-type": "text/plain; charset=utf-8",
              },
            })
          : new Response("unauthorized", { status: 401 }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const modernDelegate = new FakeAdapter();
    const createModernAdapter = vi.fn(() => modernDelegate);
    const probeExecutable = vi.fn(() =>
      externalWebRunning
        ? Promise.reject(
            new DeepSeekGenerationProbeError(
              "notInstalled",
              "No local DeepSeek Harness executable was found",
            ),
          )
        : Promise.resolve(modernExecutable),
    );
    const endpoint = "http://127.0.0.1:43123/";
    const adapter = new DeepSeekHarnessAdapter(
      { endpoint },
      {
        probeExecutable,
        createModernAdapter,
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "authenticationRequired",
        message:
          "检测到配置的端点上已有 DeepSeek Harness Modern Web 实例，但当前 codexhost 实例没有其认证凭据。请关闭该 DSH Web 实例，然后重新运行连接诊断。\nA DeepSeek Harness Modern Web instance is listening at the configured endpoint, but this codexhost instance does not have its authentication credentials. Close that DSH Web instance, then run connection diagnostics again.",
        retryable: false,
        stage: "wire-handshake",
        diagnostic: "externalModernWeb",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(endpoint);
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).port === "43123")).toBe(true);
    expect(createModernAdapter).not.toHaveBeenCalled();
    externalWebRunning = false;
    await expect(adapter.inspect({ refresh: true })).resolves.toBe(readyInspection);
    expect(probeExecutable).toHaveBeenCalledTimes(2);
    expect(createModernAdapter).toHaveBeenCalledOnce();
    await adapter.close();
    expect(modernDelegate.closeCalls).toBe(1);
  });

  it.each([401, 403])(
    "does not identify an arbitrary HTTP %i service as Modern DSH",
    async (status) => {
      let cancellations = 0;
      const body = new TextEncoder().encode(`${MODERN_AUTHENTICATION_BODY}secret-canary`);
      const fetch = vi.fn((input: string | URL) => {
        const url = new URL(String(input));
        return Promise.resolve(
          url.pathname === "/"
            ? new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(body);
                  },
                  cancel() {
                    cancellations += 1;
                  },
                }),
                {
                  status,
                  headers: {
                    "cache-control": "no-store",
                    "content-type": "text/plain; charset=utf-8",
                  },
                },
              )
            : new Response(null, { status }),
        );
      });
      vi.stubGlobal("fetch", fetch);
      const createModernAdapter = vi.fn(() => new FakeAdapter());
      const adapter = new DeepSeekHarnessAdapter(
        {},
        {
          probeExecutable: () => Promise.resolve(modernExecutable),
          createModernAdapter,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection).toBe(readyInspection);
      expect(JSON.stringify(inspection)).not.toContain("secret-canary");
      expect(cancellations).toBe(1);
      expect(createModernAdapter).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/");
      await adapter.close();
    },
  );

  it("shares one concurrent selection and stays on the selected generation after refresh", async () => {
    const generation = deferred<DeepSeekExecutableGeneration>();
    const probeExecutable = vi.fn(() => generation.promise);
    const modernDelegate = new FakeAdapter();
    const createModernAdapter = vi.fn(() => modernDelegate);
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable,
        createModernAdapter,
      },
    );

    const inspection = adapter.inspect();
    const opened = adapter.open({ kind: "create", cwd: "fixture" });
    generation.resolve(modernExecutable);

    await expect(inspection).resolves.toBe(readyInspection);
    await expect(opened).resolves.toMatchObject({ ok: true });
    await expect(adapter.inspect({ refresh: true })).resolves.toBe(readyInspection);
    expect(probeExecutable).toHaveBeenCalledOnce();
    expect(createModernAdapter).toHaveBeenCalledOnce();
    expect(modernDelegate.inspectCalls).toBe(2);
    expect(modernDelegate.openCalls).toBe(1);
    await adapter.close();
  });

  it("caches a failed selection until an explicit inspect refresh", async () => {
    let probeCalls = 0;
    const modernDelegate = new FakeAdapter();
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => {
          probeCalls += 1;
          return probeCalls === 1
            ? Promise.reject(
                new DeepSeekGenerationProbeError(
                  "notInstalled",
                  "No local DeepSeek Harness executable was found",
                ),
              )
            : Promise.resolve(modernExecutable);
        },
        createModernAdapter: () => modernDelegate,
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", stage: "resolve-executable" },
    });
    await expect(adapter.open({ kind: "create", cwd: "fixture" })).resolves.toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    expect(probeCalls).toBe(1);
    await expect(adapter.inspect({ refresh: true })).resolves.toBe(readyInspection);
    expect(probeCalls).toBe(2);
    await adapter.close();
  });

  it("does not retry after failed candidate cleanup cannot be confirmed", async () => {
    const failedDelegate = new FakeAdapter(
      () => Promise.resolve(unavailableInspection),
      () => Promise.reject(new Error("cleanup failed")),
    );
    const createModernAdapter = vi.fn(() => failedDelegate);
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter,
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "internalError",
        retryable: false,
        stage: "cleanup",
        durationMs: expect.any(Number),
      },
    });
    await expect(adapter.inspect({ refresh: true })).resolves.toMatchObject({
      status: "unavailable",
      error: {
        code: "internalError",
        retryable: false,
        stage: "cleanup",
        durationMs: expect.any(Number),
      },
    });
    expect(createModernAdapter).toHaveBeenCalledOnce();
    expect(failedDelegate.closeCalls).toBe(1);
    await adapter.close();
  });

  it("closes an in-flight candidate exactly once even when candidate close rejects", async () => {
    const pendingInspection = deferred<HarnessInspection>();
    const modernDelegate = new FakeAdapter(
      () => pendingInspection.promise,
      () => Promise.reject(new Error("candidate close failed")),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const adapter = new DeepSeekHarnessAdapter(
        {},
        {
          probeExecutable: () => Promise.resolve(modernExecutable),
          createModernAdapter: () => modernDelegate,
        },
      );
      const inspection = adapter.inspect();
      while (modernDelegate.inspectCalls === 0) await waitImmediate();

      await expect(adapter.close()).rejects.toThrow(
        "DeepSeek Harness Adapter cleanup did not complete",
      );
      await expect(inspection).resolves.toMatchObject({
        status: "unavailable",
        error: { code: "invalidState" },
      });
      await waitImmediate();
      expect(modernDelegate.closeCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("propagates a selected delegate cleanup failure exactly once", async () => {
    const modernDelegate = new FakeAdapter(undefined, () =>
      Promise.reject(new Error("owned process survived")),
    );
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter: () => modernDelegate,
      },
    );
    await adapter.inspect();

    await expect(adapter.close()).rejects.toThrow(
      "DeepSeek Harness Adapter cleanup did not complete",
    );
    await expect(adapter.close()).rejects.toThrow(
      "DeepSeek Harness Adapter cleanup did not complete",
    );
    expect(modernDelegate.closeCalls).toBe(1);
  });

  it("does not inspect a selected delegate after close begins", async () => {
    const delegateClose = deferred<undefined>();
    const modernDelegate = new FakeAdapter(undefined, () => delegateClose.promise);
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter: () => modernDelegate,
      },
    );
    await expect(adapter.inspect()).resolves.toBe(readyInspection);

    const closing = adapter.close();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    expect(modernDelegate.inspectCalls).toBe(1);
    delegateClose.resolve(undefined);
    await closing;
  });

  it("aborts an in-flight version probe without creating a candidate", async () => {
    let probeSignal: AbortSignal | undefined;
    const createModernAdapter = vi.fn();
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: ({ signal }) => {
          probeSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DeepSeekGenerationProbeError(
                    "cancelled",
                    "DeepSeek Harness version probe was cancelled",
                  ),
                ),
              { once: true },
            );
          });
        },
        createModernAdapter,
      },
    );
    const inspection = adapter.inspect();
    while (!probeSignal) await waitImmediate();

    await adapter.close();
    await expect(inspection).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    expect(probeSignal.aborted).toBe(true);
    expect(createModernAdapter).not.toHaveBeenCalled();
  });

  it("reports version process cleanup failure when close aborts the probe", async () => {
    let probeSignal: AbortSignal | undefined;
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: ({ signal }) => {
          probeSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new DeepSeekGenerationProbeError(
                    "processExited",
                    "DeepSeek Harness version process cleanup did not complete",
                    { cleanupFailed: true, retryable: false },
                  ),
                ),
              { once: true },
            );
          });
        },
      },
    );
    const inspection = adapter.inspect();
    while (!probeSignal) await waitImmediate();

    await expect(adapter.close()).rejects.toThrow(
      "DeepSeek Harness Adapter cleanup did not complete",
    );
    await expect(inspection).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState", retryable: false },
    });
  });

  it("closes while an injected Modern Adapter ignores cancellation", async () => {
    const delegate = new FakeAdapter(() => new Promise<HarnessInspection>(() => undefined));
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter: () => delegate,
      },
    );
    const inspection = adapter.inspect();
    while (delegate.inspectCalls === 0) await waitImmediate();

    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(inspection).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    expect(delegate.closeCalls).toBe(1);
  });

  it("does not create a late candidate when a version probe resolves after close", async () => {
    const generation = deferred<DeepSeekExecutableGeneration>();
    const createModernAdapter = vi.fn(() => new FakeAdapter());
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => generation.promise,
        createModernAdapter,
      },
    );
    const inspection = adapter.inspect();
    const closing = adapter.close();
    generation.resolve(modernExecutable);
    await expect(closing).resolves.toBeUndefined();
    await expect(inspection).resolves.toMatchObject({ error: { code: "invalidState" } });
    expect(createModernAdapter).not.toHaveBeenCalled();
  });

  it("rejects all operations after close and never opens an unmanaged Web UI", async () => {
    const adapter = new DeepSeekHarnessAdapter();
    await expect(adapter.webUi.open()).resolves.toMatchObject({ error: { code: "unsupported" } });
    await adapter.close();
    await expect(adapter.webUi.open()).resolves.toMatchObject({ error: { code: "invalidState" } });
    await expect(adapter.open({ kind: "create", cwd: "fixture" })).resolves.toMatchObject({
      error: { code: "invalidState" },
    });
    await expect(adapter.sessionImport.listCandidates()).resolves.toMatchObject({
      error: { code: "invalidState" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves startup diagnostics and closes the failed managed candidate", async () => {
    const error = {
      code: "protocolError",
      message: "Invalid startup payload",
      retryable: false,
      diagnostic: "invalidPayload",
      stage: "handshake",
      durationMs: 3,
      stderrTail: "redacted detail",
    };
    const candidate = new FakeAdapter(() => Promise.resolve({ status: "unavailable", error }));
    const adapter = new DeepSeekHarnessAdapter(
      {},
      {
        probeExecutable: () => Promise.resolve(modernExecutable),
        createModernAdapter: () => candidate,
      },
    );
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { ...error, durationMs: expect.any(Number) },
    });
    await adapter.close();
    expect(candidate.closeCalls).toBe(1);
  });
});
