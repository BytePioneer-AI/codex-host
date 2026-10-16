import { describe, expect, it, vi } from "vitest";

import {
  createRendererCdpControlSession,
  selectAvatarOverlayRendererTargets,
  selectPrimaryRendererTarget,
} from "../src/renderer-cdp-control-session.js";
import type { CdpTarget } from "../src/cdp-client.js";

function target(id: string, url = "app://-/index.html"): CdpTarget {
  return {
    id,
    type: "page",
    title: "Codex",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:43123/devtools/page/${id}`,
  };
}

function readyBinding() {
  return {
    version: 2,
    enabledAgents: ["codex", "pi"],
    adapter: { state: "ready", reason: "ready" },
  };
}

function rendererClient(binding = readyBinding()) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const evaluateSpy = vi.fn(async (expression: string) => {
    void expression;
    return binding as unknown;
  });
  return {
    commands,
    evaluateSpy,
    command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.evaluate") return { result: { type: "undefined" } };
      return {};
    }),
    async evaluate<T>(expression: string): Promise<T> {
      return (await evaluateSpy(expression)) as T;
    },
    close: vi.fn(),
  };
}

describe("Renderer CDP Control Session", () => {
  it("selects only the exact primary app surface and preserves an owned target", () => {
    const first = target("page-1");
    const owned = target("page-2");
    expect(
      selectPrimaryRendererTarget([
        target("overlay", "app://-/avatar-overlay.html"),
        { ...target("worker"), type: "worker" },
        first,
        target("query", "app://-/index.html?window=second"),
        owned,
      ]),
    ).toBe(first);
    expect(selectPrimaryRendererTarget([first, owned], "page-2")).toBe(owned);
    expect(
      selectPrimaryRendererTarget([target("overlay", "app://-/avatar-overlay.html")]),
    ).toBeNull();
    expect(
      selectAvatarOverlayRendererTargets([
        target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        target("legacy", "app://-/avatar-overlay.html"),
        first,
        target("query", "app://-/index.html?window=second"),
      ]).map((item) => item.id),
    ).toEqual(["overlay", "legacy"]);
  });

  it("registers future-document injection before evaluating the current document", async () => {
    const client = rendererClient();
    const source = "globalThis.__codexhostInstalled = true";
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: source,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(client.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    expect(session.snapshot.binding).toEqual(readyBinding());
    session.close();
  });

  it("injects the hook-only source into the avatar overlay page", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(false);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(primary.commands).toEqual(
      expect.arrayContaining([
        {
          method: "Page.addScriptToEvaluateOnNewDocument",
          params: { source: "production renderer" },
        },
      ]),
    );
    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "overlay hook only" } },
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay hook only", awaitPromise: true },
      },
    ]);
    session.close();
  });

  it("keeps the primary session when overlay CDP connect fails", async () => {
    const primary = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) => {
          if (webSocketDebuggerUrl.includes("overlay")) {
            throw new Error("overlay closed between list and connect");
          }
          return primary;
        }),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(session.snapshot.binding).toEqual(readyBinding());
    expect(primary.close).not.toHaveBeenCalled();
    session.close();
  });

  it("re-injects the hook-only overlay bundle when a reload drops the hook", async () => {
    const primary = rendererClient();
    const overlay = rendererClient();
    overlay.evaluateSpy.mockResolvedValue(false);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [
          target("page-1"),
          target("overlay", "app://-/index.html?initialRoute=%2Favatar-overlay"),
        ]),
        connect: vi.fn(async (webSocketDebuggerUrl: string) =>
          webSocketDebuggerUrl.includes("overlay") ? overlay : primary,
        ),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    overlay.commands.length = 0;
    await session.ensureInstalled();

    expect(overlay.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "overlay hook only" } },
      {
        method: "Runtime.evaluate",
        params: { expression: "overlay hook only", awaitPromise: true },
      },
    ]);
    expect(
      overlay.commands.some(
        ({ params }) =>
          params?.source === "production renderer" || params?.expression === "production renderer",
      ),
    ).toBe(false);
    session.close();
  });

  it.each(["connect", "command", "evaluate"] as const)(
    "bounds stalled overlay %s operations without blocking other overlays",
    async (stage) => {
      const primary = rendererClient();
      const stalled = rendererClient();
      const healthy = rendererClient();
      healthy.evaluateSpy.mockResolvedValue(false);
      let finishConnect: ((client: typeof stalled) => void) | undefined;
      const pendingConnect = new Promise<typeof stalled>((resolve) => {
        finishConnect = resolve;
      });
      if (stage === "command") {
        stalled.command.mockImplementation(() => new Promise(() => {}));
      }
      if (stage === "evaluate") {
        stalled.evaluateSpy.mockImplementation(() => new Promise(() => {}));
      }
      const session = await createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        overlayHookSource: "overlay hook only",
        timeoutMs: 40,
        operations: {
          listTargets: async () => [
            target("page-1"),
            target("stalled", "app://-/avatar-overlay.html"),
            target("healthy", "app://-/avatar-overlay.html"),
          ],
          connect: async (url) => {
            if (url.endsWith("/stalled")) return stage === "connect" ? pendingConnect : stalled;
            return url.endsWith("/healthy") ? healthy : primary;
          },
          installDraftPrewarmPolicy: async () => ({
            state: "ready",
            reason: "owned-request-bridge",
          }),
        },
      });
      try {
        expect(session.snapshot.binding).toEqual(readyBinding());
        expect(primary.close).not.toHaveBeenCalled();
        expect(healthy.commands).toContainEqual({
          method: "Runtime.evaluate",
          params: { expression: "overlay hook only", awaitPromise: true },
        });
        expect(healthy.close).toHaveBeenCalledOnce();
        if (stage === "connect") {
          expect(stalled.close).not.toHaveBeenCalled();
          finishConnect?.(stalled);
          await vi.waitFor(() => expect(stalled.close).toHaveBeenCalledOnce());
          expect(stalled.command).not.toHaveBeenCalled();
        } else {
          expect(stalled.close).toHaveBeenCalledOnce();
        }
        await expect(session.ensureInstalled()).resolves.toMatchObject({ binding: readyBinding() });
      } finally {
        session.close();
      }
    },
  );

  it("reconciles a changed Host before judging the previous Adapter readiness", async () => {
    const binding = readyBinding();
    const client = rendererClient(binding);
    const connect = vi.fn(async () => client);
    const installDraftPrewarmPolicy = vi.fn(async () => {
      binding.adapter.state = "ready";
      binding.adapter.reason = "ready";
      return { state: "ready" as const, reason: "owned-request-bridge" as const };
    });
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: async () => [target("page-1")],
        connect,
        installDraftPrewarmPolicy,
      },
    });
    try {
      binding.adapter.state = "installing";
      binding.adapter.reason = "draft-routing-policy-unavailable";
      await expect(session.ensureInstalled()).resolves.toMatchObject({
        binding: { adapter: { state: "ready" } },
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(client.close).not.toHaveBeenCalled();
      expect(installDraftPrewarmPolicy).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }
  });

  it("activates the owned page target", async () => {
    const client = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.activateDesktop()).resolves.toBe(1);
    expect(client.command).toHaveBeenLastCalledWith("Page.bringToFront");
    session.close();
  });

  it("accepts the Renderer Agent list in its own presentation order", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["pi", "codex"],
      adapter: { state: "ready", reason: "ready" },
    } as never);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      enabledAgents: ["codex", "pi"],
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.ensureInstalled()).resolves.toMatchObject({
      binding: { enabledAgents: ["pi", "codex"] },
    });
    // A healthy check must not re-run the Renderer bundle, which remounts every Composer control.
    expect(
      client.commands.filter(
        ({ method, params }) =>
          method === "Runtime.evaluate" && params?.expression === "production renderer",
      ),
    ).toHaveLength(1);
    session.close();
  });

  it("fails closed when CDP target discovery hangs past its timeout", async () => {
    const client = rendererClient();
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 10,
        timeoutMs: 40,
        operations: {
          listTargets: vi.fn((_endpoint, signal) => {
            return new Promise<CdpTarget[]>((_resolve, reject) => {
              const fail = (): void => reject(new Error("Renderer CDP target discovery timed out"));
              if (signal?.aborted) {
                fail();
                return;
              }
              signal?.addEventListener("abort", fail, { once: true });
            });
          }),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Primary Codex Renderer CDP target did not become ready");
    expect(client.close).not.toHaveBeenCalled();
  });

  it("keeps the primary session when overlay CDP discovery hangs past its timeout", async () => {
    const primary = rendererClient();
    let calls = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      overlayHookSource: "overlay hook only",
      pollIntervalMs: 10,
      timeoutMs: 40,
      operations: {
        listTargets: vi.fn((_endpoint, signal) => {
          calls += 1;
          if (calls % 2 === 1) return Promise.resolve([target("page-1")]);
          return new Promise<CdpTarget[]>((_resolve, reject) => {
            const fail = (): void => reject(new Error("Overlay CDP target discovery timed out"));
            if (signal?.aborted) {
              fail();
              return;
            }
            signal?.addEventListener("abort", fail, { once: true });
          });
        }),
        connect: vi.fn(async () => primary),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(session.snapshot.binding).toEqual(readyBinding());
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      binding: readyBinding(),
    });
    expect(primary.close).not.toHaveBeenCalled();
    session.close();
  });

  it("fails closed when the injected Adapter is unsupported", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["codex", "pi"],
      adapter: { state: "unsupported", reason: "signature-mismatch" },
    } as never);
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 1,
        timeoutMs: 100,
        operations: {
          listTargets: vi.fn(async () => [target("page-1")]),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Production Renderer Adapter is unsupported: signature-mismatch");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reconnects and installs a replacement primary target", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      target: { id: "page-2" },
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    await session.executeRenderer("42");
    expect(replacement.evaluateSpy).toHaveBeenLastCalledWith("42");
    session.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("does not replace the installed snapshot when replacement installation fails", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs > 1) throw new Error("request manager unavailable");
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).rejects.toThrow("request manager unavailable");
    expect(session.snapshot.target.id).toBe("page-1");
    expect(first.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
    session.close();
  });
});
