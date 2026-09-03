import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";
import type { RendererCdpControlSession } from "../src/renderer-cdp-control-session.js";

const attachmentNonce = "0123456789abcdef0123456789abcdef";

function controllerOptions() {
  return {
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/renderer.js",
    defaultAgent: "pi" as const,
    attachmentPort: 43124,
    attachmentNonce,
  };
}

function attachmentServer() {
  return { close: vi.fn(async () => {}) };
}

function controllerSnapshot(): RendererCdpControlSession["snapshot"] {
  return {} as RendererCdpControlSession["snapshot"];
}

describe("production Desktop Controller", () => {
  it("accepts only a loopback Renderer CDP endpoint, absolute Renderer path, and strict attachment fields", () => {
    const rendererPath = path.resolve("fixtures/renderer-extension.js");
    expect(
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--default-agent",
        "pi",
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
      ]),
    ).toEqual({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererPath,
      defaultAgent: "pi",
      attachmentPort: 43124,
      attachmentNonce,
    });
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://example.com:43123",
        "--renderer",
        "/renderer.js",
      ]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "renderer.js",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--default-agent",
        "pi",
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        "bad",
      ]),
    ).toThrow("32 lowercase hexadecimal");
  });

  it("serializes only strict and bounded readiness results", () => {
    expect(
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      }),
    ).toBe('{"schemaVersion":2,"state":"compatible","issues":[]}');
    expect(() =>
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "incompatible",
        issues: [],
      } as never),
    ).toThrow("readiness is invalid");
  });

  it("signals compatible readiness, serves attachment, and monitors recovery", async () => {
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const ensureInstalled = vi.fn(async () => {
      abort.abort();
      return snapshot;
    });
    const activateDesktop = vi.fn(async () => 1);
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled,
      activateDesktop,
      executeRenderer: vi.fn(),
      close,
    };
    const ready = vi.fn();
    const install = vi.fn(async () => session);
    const server = attachmentServer();
    let attach: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      return server;
    });
    const dependencies: DesktopControllerDependencies = {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    };

    await runDesktopController(controllerOptions(), abort.signal, dependencies);

    expect(install).toHaveBeenCalledWith({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource:
        'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;\nObject.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: "pi" } });\nproduction renderer',
      enabledAgents: [
        "codex",
        "pi",
        "claude-code",
        "deepseek-harness",
        "opencode",
        "grok",
        "omp",
        "antigravity",
      ],
      timeoutMs: 90_000,
    });
    expect(startAttachmentServer).toHaveBeenCalledWith({
      port: 43124,
      nonce: attachmentNonce,
      attach: expect.any(Function),
    });
    expect(ready).toHaveBeenCalledWith({
      schemaVersion: 2,
      state: "compatible",
      issues: [],
    });
    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(attach).toEqual(expect.any(Function));
  });

  it("retries a transient Renderer evaluation failure during cold startup", async () => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error("Renderer installation failed", {
          cause: new Error("Execution context was destroyed during Renderer reload"),
        }),
      )
      .mockRejectedValueOnce(new Error("Promise was collected"))
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    const sleep = vi.fn(async () => {});

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers an unclassified inspection failure after managed readiness", async () => {
    const abort = new AbortController();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Inspector target is not ready"))
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      if (milliseconds === 1) currentTime += 30_000;
      if (install.mock.calls.length >= 2) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses a structural installation failure and starts attachment", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const install = vi.fn(async () => {
      throw new Error("Production Renderer Adapter is unsupported: signature-mismatch");
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("signature-mismatch");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("suppresses an unclassified inspection failure without leaking its error", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => {
        throw new Error("/private/user/path and request details");
      }),
      install: vi.fn(),
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("private/user");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("installs on demand when attachment arrives during recovery", async () => {
    const abort = new AbortController();
    const activateDesktop = vi.fn(async () => 1);
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop,

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Composer is not ready"))
      .mockResolvedValueOnce(session);
    let attach: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      return attachmentServer();
    });
    const sleep = vi.fn(async () => {
      await attach?.();
      abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready: vi.fn(),
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(activateDesktop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("replaces a ready Session after Renderer recovery fails", async () => {
    const abort = new AbortController();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const first: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => {
        throw new Error("Renderer binding disappeared");
      }),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close: firstClose,
    };
    const second: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close: secondClose,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    let monitorCycles = 0;
    let currentTime = 0;
    const sleep = vi.fn(async () => {
      monitorCycles += 1;
      currentTime += 30_000;
      if (monitorCycles === 3) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready: vi.fn(),
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });
});
