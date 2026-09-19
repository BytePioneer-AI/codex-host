import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRendererCdpControlSession,
  runDesktopController,
  type DesktopControllerDependencies,
} from "@codexhost/desktop-control";
import { DEFAULT_RENDERER_AGENTS } from "../src/agent-selection-state.js";

describe("production Controller / Renderer Agent contract", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts the actual Renderer Agent set without reinjecting a healthy page", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let clock = 0;
    let ticks = 0;
    const client = {
      command: vi.fn<(method: string) => Promise<unknown>>(async () => ({})),
      async evaluate<T>(): Promise<T> {
        return {
          version: 2,
          enabledAgents: [...DEFAULT_RENDERER_AGENTS],
          adapter: { state: "ready", reason: "ready" },
        } as T;
      },
      close: vi.fn(),
    };
    const install = vi.fn<DesktopControllerDependencies["install"]>((options) =>
      createRendererCdpControlSession({
        ...options,
        timeoutMs: 50,
        pollIntervalMs: 1,
        operations: {
          listTargets: async () => [
            {
              id: "synthetic-renderer",
              type: "page",
              title: "Codex",
              url: "app://-/index.html",
              webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/synthetic-renderer",
            },
          ],
          connect: async () => client,
          installDraftPrewarmPolicy: async () => ({
            state: "ready",
            reason: "owned-request-bridge",
          }),
        },
      }),
    );
    const run = runDesktopController(
      {
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererPath: "/synthetic/renderer.js",
        defaultAgent: "codex",
        attachmentPort: 43124,
        attachmentNonce: "0123456789abcdef0123456789abcdef",
      },
      abort.signal,
      {
        readRenderer: async () => "synthetic production Renderer",
        install,
        startAttachmentServer: async () => ({ close: async () => {} }),
        ready: vi.fn(),
        now: () => clock,
        sleep: async () => {
          clock += 31_000;
          if (++ticks === 2) abort.abort();
        },
        monitorIntervalMs: 500,
      },
    );
    await vi.runAllTimersAsync();
    await run;
    expect(install).toHaveBeenCalled();
    expect(install.mock.calls[0]?.[0].enabledAgents).toEqual([...DEFAULT_RENDERER_AGENTS]);
    expect(
      client.command.mock.calls.filter(([method]) => method === "Runtime.evaluate"),
    ).toHaveLength(1);
  });
});
