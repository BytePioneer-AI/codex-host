import { runInThisContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  activateElectronDesktop,
  createRendererControlSession,
  inspectElectronWebContents,
  selectRendererWebContents,
  waitForInspectorTarget,
  waitForRendererTitlePolicyReady,
  type ElectronRendererSummary,
} from "../src/renderer-control-session.js";

function renderer(id: number, surface: "primary" | "overlay", elementCount: number) {
  return {
    id,
    type: "window",
    surface,
    runtime: {
      available: true,
      elementCount,
    },
  } satisfies ElectronRendererSummary;
}

function readyBinding() {
  return {
    version: 2,
    enabledAgents: ["codex", "pi"],
    adapter: { state: "ready", reason: "ready" },
  };
}

describe("Renderer Control Session", () => {
  it("activates at least one live Electron window through the main Inspector", async () => {
    const evaluate = vi.fn<(expression: string) => Promise<number>>(async () => 2);
    const inspector = {
      async evaluate<T>(expression: string): Promise<T> {
        return (await evaluate(expression)) as unknown as T;
      },
    };
    await expect(activateElectronDesktop(inspector)).resolves.toBe(2);
    expect(evaluate).toHaveBeenCalledWith(expect.stringContaining("window.focus()"));
    await expect(
      activateElectronDesktop({
        async evaluate<T>(): Promise<T> {
          return 0 as unknown as T;
        },
      }),
    ).rejects.toThrow("found no live window");
  });

  it("selects any live primary window without an arbitrary population threshold", () => {
    const primary = renderer(17, "primary", 1);
    expect(selectRendererWebContents([renderer(18, "overlay", 1_000), primary])).toBe(primary);
    expect(selectRendererWebContents([renderer(17, "primary", 0)])).toBeNull();
  });

  it("waits for the loopback Node Inspector target", async () => {
    await expect(
      waitForInspectorTarget("http://127.0.0.1:43123", {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return [
              {
                id: "node-1",
                type: "node",
                title: "ChatGPT",
                url: "file://",
                webSocketDebuggerUrl: "ws://127.0.0.1:43123/node-1",
              },
            ];
          },
        }),
      }),
    ).resolves.toMatchObject({ id: "node-1", type: "node" });
  });

  it("returns only Renderer fields used by control decisions", async () => {
    const inspector = {
      async evaluate<T>(): Promise<T> {
        return [
          {
            id: 17,
            type: "window",
            surface: "primary",
            url: "app://-/index.html?private=value",
            runtime: {
              available: true,
              elementCount: 100,
            },
          },
        ] as T;
      },
    };
    await expect(inspectElectronWebContents(inspector)).resolves.toEqual([
      renderer(17, "primary", 100),
    ]);
  });

  it("checks all Electron webContents concurrently within one Inspector evaluation", async () => {
    const contents = [
      {
        id: 17,
        executeJavaScript: vi.fn(async () => ({ elementCount: 100 })),
        getType: () => "window",
        getURL: () => "app://-/index.html",
      },
      {
        id: 18,
        executeJavaScript: vi.fn(async () => ({ elementCount: 0 })),
        getType: () => "window",
        getURL: () => "app://-/avatar-overlay.html",
      },
    ];
    const previousMainModule = Object.getOwnPropertyDescriptor(process, "mainModule");
    Object.defineProperty(process, "mainModule", {
      configurable: true,
      value: {
        require: () => ({
          webContents: {
            getAllWebContents: () => contents,
          },
        }),
      },
    });

    try {
      const inspector = {
        async evaluate<T>(expression: string): Promise<T> {
          return (await runInThisContext(expression)) as T;
        },
      };

      await expect(inspectElectronWebContents(inspector)).resolves.toEqual([
        renderer(17, "primary", 100),
        renderer(18, "overlay", 0),
      ]);
      expect(contents[0]?.executeJavaScript).toHaveBeenCalledOnce();
      expect(contents[1]?.executeJavaScript).toHaveBeenCalledOnce();
    } finally {
      if (previousMainModule) {
        Object.defineProperty(process, "mainModule", previousMainModule);
      } else {
        delete (process as { mainModule?: unknown }).mainModule;
      }
    }
  });

  it("waits for metadata ownership before readiness", async () => {
    let currentTime = 0;
    const markReadiness = vi
      .fn()
      .mockRejectedValueOnce(new Error("ownership unavailable"))
      .mockResolvedValue({ state: "ready", reason: "owned-metadata-service" });
    await expect(
      waitForRendererTitlePolicyReady(markReadiness, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toEqual({ state: "ready", reason: "owned-metadata-service" });
    expect(markReadiness).toHaveBeenCalledTimes(2);
  });

  it("owns the fixed policy, reload, injection, and recovery order", async () => {
    const calls: string[] = [];
    let binding: unknown = null;
    let selected = renderer(17, "primary", 100);
    const inspector = {
      command: vi.fn(),
      evaluate: vi.fn().mockResolvedValue(1),
      close: vi.fn(),
    };
    const operations = {
      async inspect() {
        calls.push("inspect");
        return [selected];
      },
      async installTitlePolicy(_inspector: unknown, rendererId: number) {
        calls.push(`title:${rendererId}`);
        return {
          state: "ready" as const,
          reason: "ready" as const,
          requiresRendererReload: true as const,
        };
      },
      async markTitlePolicyReady(_inspector: unknown, rendererId: number) {
        calls.push(`title-ready:${rendererId}`);
        return { state: "ready" as const, reason: "owned-metadata-service" as const };
      },
      async installDraftPrewarmPolicy(_inspector: unknown, rendererId: number) {
        calls.push(`prewarm:${rendererId}`);
        return { state: "ready" as const, reason: "owned-request-bridge" as const };
      },
      async reload() {
        calls.push("reload");
        binding = null;
      },
      async execute(_inspector: unknown, _rendererId: number, source: string) {
        if (source.includes("requestCompatibilityUpdate")) {
          calls.push("compatibility-update");
          return "current";
        }
        calls.push("inject");
        binding = readyBinding();
        return null;
      },
      async readBinding() {
        calls.push("read-binding");
        return binding;
      },
      async readTitlePolicyCounters() {
        return null;
      },
    };

    const session = await createRendererControlSession({
      inspector,
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations,
    });
    expect(calls).toEqual([
      "inspect",
      "title:17",
      "reload",
      "inspect",
      "title-ready:17",
      "inject",
      "prewarm:17",
      "read-binding",
    ]);
    expect(session.snapshot.binding).toEqual(readyBinding());
    expect(session.snapshot.titlePolicy).toEqual({
      state: "ready",
      reason: "ready",
      requiresRendererReload: true,
    });

    calls.length = 0;
    await expect(session.requestCompatibilityUpdate()).resolves.toBe("current");
    expect(calls).toEqual(["compatibility-update"]);

    calls.length = 0;
    await expect(session.ensureInstalled()).resolves.toMatchObject({ renderer: { id: 17 } });
    expect(calls).toEqual(["inspect", "read-binding", "prewarm:17"]);

    calls.length = 0;
    binding = null;
    selected = renderer(19, "primary", 120);
    await expect(session.ensureInstalled()).resolves.toMatchObject({ renderer: { id: 19 } });
    expect(calls).toEqual([
      "inspect",
      "read-binding",
      "title-ready:19",
      "inject",
      "prewarm:19",
      "read-binding",
    ]);
    session.close();
    expect(inspector.close).toHaveBeenCalledOnce();
  });

  it("waits for an installing Renderer Adapter", async () => {
    const selected = renderer(17, "primary", 100);
    const readBinding = vi
      .fn()
      .mockResolvedValueOnce({
        version: 2,
        enabledAgents: ["codex", "pi"],
        adapter: { state: "installing", reason: "installing" },
      })
      .mockResolvedValue(readyBinding());
    const operations = {
      async inspect() {
        return [selected];
      },
      async installTitlePolicy() {
        return {
          state: "ready" as const,
          reason: "ready" as const,
          requiresRendererReload: true as const,
        };
      },
      async markTitlePolicyReady() {
        return { state: "ready" as const, reason: "owned-metadata-service" as const };
      },
      async installDraftPrewarmPolicy() {
        return { state: "ready" as const, reason: "owned-request-bridge" as const };
      },
      async reload() {},
      async execute() {
        return null;
      },
      readBinding,
      async readTitlePolicyCounters() {
        return null;
      },
    };

    const session = await createRendererControlSession({
      inspector: { command: vi.fn(), evaluate: vi.fn().mockResolvedValue(1), close: vi.fn() },
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations,
    });

    expect(session.snapshot.binding).toEqual(readyBinding());
    expect(readBinding).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("fails closed when the injected Adapter is unsupported", async () => {
    const selected = renderer(17, "primary", 100);
    const operations = {
      async inspect() {
        return [selected];
      },
      async installTitlePolicy() {
        return {
          state: "ready" as const,
          reason: "ready" as const,
          requiresRendererReload: true as const,
        };
      },
      async markTitlePolicyReady() {
        return { state: "ready" as const, reason: "owned-metadata-service" as const };
      },
      async installDraftPrewarmPolicy() {
        return { state: "ready" as const, reason: "owned-request-bridge" as const };
      },
      async reload() {},
      async execute() {
        return null;
      },
      async readBinding() {
        return {
          version: 2,
          enabledAgents: ["codex", "pi"],
          adapter: { state: "unsupported", reason: "signature-mismatch" },
        };
      },
      async readTitlePolicyCounters() {
        return null;
      },
    };

    const failure = createRendererControlSession({
      inspector: { command: vi.fn(), evaluate: vi.fn().mockResolvedValue(1), close: vi.fn() },
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations,
    });
    await expect(failure).rejects.toThrow(
      "Production Renderer Adapter is unsupported: signature-mismatch",
    );
  });
});
