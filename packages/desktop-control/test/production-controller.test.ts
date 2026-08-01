import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";
import type { RendererControlSession } from "../src/renderer-control-session.js";

describe("production Desktop Controller", () => {
  it("accepts only a loopback Inspector and absolute Renderer path", () => {
    expect(
      parseDesktopControllerArguments([
        "--inspector-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "/Applications/codexhost.app/Contents/Resources/app/renderer-extension.js",
        "--default-agent",
        "pi",
      ]),
    ).toEqual({
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererPath: "/Applications/codexhost.app/Contents/Resources/app/renderer-extension.js",
      defaultAgent: "pi",
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
  });

  it("signals ready, monitors recovery, and closes on abort", async () => {
    const abort = new AbortController();
    const snapshot = {} as RendererControlSession["snapshot"];
    const ensureInstalled = vi.fn(async () => {
      abort.abort();
      return snapshot;
    });
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot,
      ensureInstalled,
      executeRenderer: vi.fn(),
      readTitlePolicyCounters: vi.fn(),
      close,
    };
    const ready = vi.fn();
    const install = vi.fn(async () => session);
    const dependencies: DesktopControllerDependencies = {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    };

    await runDesktopController(
      {
        inspectorEndpoint: "http://127.0.0.1:43123",
        rendererPath: "/renderer.js",
        defaultAgent: "pi",
      },
      abort.signal,
      dependencies,
    );

    expect(install).toHaveBeenCalledWith({
      inspectorEndpoint: "http://127.0.0.1:43123",
      rendererSource:
        'Object.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: "pi" } });\nproduction renderer',
      enabledAgents: ["codex", "pi", "claude-code"],
      timeoutMs: 90_000,
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retries a transient Electron evaluation failure during cold startup", async () => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererControlSession = {
      snapshot: {} as RendererControlSession["snapshot"],
      ensureInstalled: vi.fn(),
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

    await runDesktopController(
      {
        inspectorEndpoint: "http://127.0.0.1:43123",
        rendererPath: "/renderer.js",
        defaultAgent: "pi",
      },
      abort.signal,
      {
        readRenderer: vi.fn(async () => "production renderer"),
        install,
        ready,
        sleep,
        monitorIntervalMs: 1,
      },
    );

    expect(install).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(ready).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not signal ready or retry when the initial installation fails structurally", async () => {
    const ready = vi.fn();
    const dependencies: DesktopControllerDependencies = {
      readRenderer: vi.fn(async () => "production renderer"),
      install: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    };

    await expect(
      runDesktopController(
        {
          inspectorEndpoint: "http://127.0.0.1:43123",
          rendererPath: "/renderer.js",
          defaultAgent: "pi",
        },
        new AbortController().signal,
        dependencies,
      ),
    ).rejects.toThrow("signature mismatch");
    expect(dependencies.install).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });
});
