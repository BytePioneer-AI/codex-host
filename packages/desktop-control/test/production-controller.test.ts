import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  serializeDesktopControllerReadiness,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";
import type { RendererControlSession } from "../src/renderer-control-session.js";

const attachmentNonce = "0123456789abcdef0123456789abcdef";

function controllerOptions() {
  return {
    inspectorEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/renderer.js",
    defaultAgent: "pi" as const,
    attachmentPort: 43124,
    attachmentNonce,
  };
}

function attachmentServer() {
  return { close: vi.fn(async () => {}) };
}

function controllerSnapshot(
  warnings: RendererControlSession["snapshot"]["titlePolicy"]["warnings"] = [],
): RendererControlSession["snapshot"] {
  return { titlePolicy: { warnings } } as RendererControlSession["snapshot"];
}

describe("production Desktop Controller", () => {
  it("accepts only a loopback Inspector, absolute Renderer path, and strict attachment fields", () => {
    const rendererPath = path.resolve("fixtures/renderer-extension.js");
    expect(
      parseDesktopControllerArguments([
        "--inspector-endpoint",
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
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererPath,
      defaultAgent: "pi",
      attachmentPort: 43124,
      attachmentNonce,
    });
    expect(() =>
      parseDesktopControllerArguments([
        "--inspector-endpoint",
        "http://example.com:43123",
        "--renderer",
        "/renderer.js",
      ]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseDesktopControllerArguments([
        "--inspector-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "renderer.js",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseDesktopControllerArguments([
        "--inspector-endpoint",
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
    expect(() =>
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "compatible-with-warning",
        issues: [
          {
            capability: "title-isolation",
            reason: "unreviewed-title-service-identity",
            observedIdentity: "identity with spaces",
          },
        ],
      }),
    ).toThrow("readiness is invalid");
  });

  it("signals ready with sanitized warnings, serves attachment, and monitors recovery", async () => {
    const abort = new AbortController();
    const warning = {
      capability: "title-isolation" as const,
      reason: "unreviewed-title-service-identity" as const,
      observedIdentity: "FutureTitleService",
    };
    const snapshot = controllerSnapshot([warning]);
    const ensureInstalled = vi.fn(async () => {
      abort.abort();
      return snapshot;
    });
    const activateDesktop = vi.fn(async () => 1);
    const requestCompatibilityUpdate = vi.fn(async () => "current" as const);
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot,
      ensureInstalled,
      activateDesktop,
      requestCompatibilityUpdate,
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
      close,
    };
    const ready = vi.fn();
    const install = vi.fn(async () => session);
    const server = attachmentServer();
    let attach: (() => Promise<void>) | undefined;
    let compatibilityUpdate:
      (() => Promise<"update-started" | "current" | "unavailable">) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      compatibilityUpdate = options.compatibilityUpdate;
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
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererSource:
        'Object.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: "pi" } });\nproduction renderer',
      enabledAgents: ["codex", "pi", "claude-code", "deepseek-harness", "grok"],
      timeoutMs: 90_000,
    });
    expect(startAttachmentServer).toHaveBeenCalledWith({
      port: 43124,
      nonce: attachmentNonce,
      attach: expect.any(Function),
      compatibilityUpdate: expect.any(Function),
    });
    expect(ready).toHaveBeenCalledWith({
      schemaVersion: 2,
      state: "compatible-with-warning",
      issues: [warning],
    });
    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(attach).toEqual(expect.any(Function));
    expect(compatibilityUpdate).toEqual(expect.any(Function));
    await expect(compatibilityUpdate?.()).resolves.toBe("current");
    expect(requestCompatibilityUpdate).toHaveBeenCalledOnce();
  });

  it("retries a transient Electron evaluation failure during cold startup", async () => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      requestCompatibilityUpdate: vi.fn(async () => "unavailable" as const),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
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
    const session: RendererControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      requestCompatibilityUpdate: vi.fn(async () => "unavailable" as const),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
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
    const session: RendererControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop,

      requestCompatibilityUpdate: vi.fn(async () => "unavailable" as const),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
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
    const first: RendererControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => {
        throw new Error("Renderer binding disappeared");
      }),
      activateDesktop: vi.fn(async () => 1),

      requestCompatibilityUpdate: vi.fn(async () => "unavailable" as const),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
      close: firstClose,
    };
    const second: RendererControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      requestCompatibilityUpdate: vi.fn(async () => "unavailable" as const),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
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
