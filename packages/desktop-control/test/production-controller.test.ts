import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
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

  it("signals ready, serves attachment, monitors recovery, and closes on abort", async () => {
    const abort = new AbortController();
    const snapshot = {} as RendererControlSession["snapshot"];
    const ensureInstalled = vi.fn(async () => {
      abort.abort();
      return snapshot;
    });
    const activateDesktop = vi.fn(async () => 1);
    const quitDesktop = vi.fn(async () => {});
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot,
      ensureInstalled,
      activateDesktop,
      quitDesktop,
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
      close,
    };
    const ready = vi.fn();
    const install = vi.fn(async () => session);
    const server = attachmentServer();
    let attach: (() => Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      shutdown = options.shutdown;
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
      enabledAgents: ["codex", "pi", "claude-code"],
      timeoutMs: 90_000,
    });
    expect(startAttachmentServer).toHaveBeenCalledWith({
      port: 43124,
      nonce: attachmentNonce,
      attach: expect.any(Function),
      shutdown: expect.any(Function),
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(attach).toEqual(expect.any(Function));
    expect(shutdown).toEqual(expect.any(Function));
  });

  it("retries a transient Electron evaluation failure during cold startup", async () => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot: {} as RendererControlSession["snapshot"],
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),
      quitDesktop: vi.fn(async () => {}),
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error(
          "Uncaught (in promise) TypeError: The argument 'filename' must be an absolute path string. Received undefined",
        ),
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
    expect(ready).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not signal ready or start attachment when installation fails structurally", async () => {
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const dependencies: DesktopControllerDependencies = {
      readRenderer: vi.fn(async () => "production renderer"),
      install: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    };

    await expect(
      runDesktopController(controllerOptions(), new AbortController().signal, dependencies),
    ).rejects.toThrow("signature mismatch");
    expect(dependencies.install).toHaveBeenCalledOnce();
    expect(startAttachmentServer).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
});
