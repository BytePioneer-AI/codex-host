import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_NO_PROXY_ENV,
  ANTIGRAVITY_PROXY_ENV,
  AntigravityAdapter,
  isLoopbackProxy,
  isTransientNetworkError,
  resolveAntigravityEnvironment,
} from "../src/index.js";

async function fakeResilientAgy(scriptLogic: string): Promise<{
  command: string;
  cwd: string;
  directory: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-resilience-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-resilience-cwd-"));
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  const scriptContent = `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.some((arg) => arg.includes("models") || arg.includes("usage"))) {
  if (process.argv.some((arg) => arg.includes("models"))) {
    process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  }
  process.exit(0);
}

const stateFile = path.join(${JSON.stringify(directory)}, "attempt.txt");
let attempt = 1;
try {
  attempt = parseInt(fs.readFileSync(stateFile, "utf8"), 10) + 1;
} catch {
  attempt = 1;
}
fs.writeFileSync(stateFile, String(attempt), "utf8");

${scriptLogic}
`;
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, scriptContent);
  if (process.platform === "win32") {
    const command = path.join(directory, "agy.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
    return { command, cwd, directory, cleanup };
  }
  const command = path.join(directory, "agy");
  await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
  await chmod(command, 0o755);
  return { command, cwd, directory, cleanup };
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>): Promise<HostEvent> {
  const result = await iterator.next();
  if (result.done) throw new Error("Output stream ended unexpectedly");
  if (result.value.kind !== "event") throw new Error("Expected an event output");
  return result.value.event;
}

describe("Antigravity Proxy & Network Resilience", () => {
  describe("resolveAntigravityEnvironment", () => {
    it("strips all proxy variables when proxy is set to direct", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "http://127.0.0.1:8888",
        HTTPS_PROXY: "http://127.0.0.1:8888",
        http_proxy: "http://127.0.0.1:8888",
        https_proxy: "http://127.0.0.1:8888",
        ALL_PROXY: "socks5://127.0.0.1:1080",
        all_proxy: "socks5://127.0.0.1:1080",
        [ANTIGRAVITY_PROXY_ENV]: "direct",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBeUndefined();
      expect(resolved.HTTPS_PROXY).toBeUndefined();
      expect(resolved.http_proxy).toBeUndefined();
      expect(resolved.https_proxy).toBeUndefined();
      expect(resolved.ALL_PROXY).toBeUndefined();
      expect(resolved.all_proxy).toBeUndefined();
    });

    it("preserves system proxy variables when proxy is set to system", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "http://127.0.0.1:8888",
        HTTPS_PROXY: "http://127.0.0.1:8888",
        [ANTIGRAVITY_PROXY_ENV]: "system",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBe("http://127.0.0.1:8888");
      expect(resolved.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
    });

    it("overrides proxy variables when explicit proxy URL is provided", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "http://127.0.0.1:8888",
        [ANTIGRAVITY_PROXY_ENV]: "http://proxy.internal:7890",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBe("http://proxy.internal:7890");
      expect(resolved.HTTPS_PROXY).toBe("http://proxy.internal:7890");
      expect(resolved.http_proxy).toBe("http://proxy.internal:7890");
      expect(resolved.https_proxy).toBe("http://proxy.internal:7890");
    });

    it("combines and deduplicates NO_PROXY bypass rules", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
        [ANTIGRAVITY_NO_PROXY_ENV]: "127.0.0.1,googleapis.com,.internal.net",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.NO_PROXY).toBe("localhost,127.0.0.1,googleapis.com,.internal.net");
      expect(resolved.no_proxy).toBe("localhost,127.0.0.1,googleapis.com,.internal.net");
    });

    it("strips empty proxy environment variables", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBeUndefined();
      expect(resolved.HTTPS_PROXY).toBeUndefined();
      expect(resolved.http_proxy).toBeUndefined();
      expect(resolved.https_proxy).toBeUndefined();
    });

    it("automatically strips loopback proxies (127.0.0.1, localhost) when no explicit proxy is configured", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "http://127.0.0.1:8888",
        HTTPS_PROXY: "http://127.0.0.1:8888",
        http_proxy: "http://localhost:8888",
        https_proxy: "http://[::1]:8888",
        ALL_PROXY: "socks5://127.0.0.1:1080",
        all_proxy: "socks5://127.0.0.1:1080",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBeUndefined();
      expect(resolved.HTTPS_PROXY).toBeUndefined();
      expect(resolved.http_proxy).toBeUndefined();
      expect(resolved.https_proxy).toBeUndefined();
      expect(resolved.ALL_PROXY).toBeUndefined();
      expect(resolved.all_proxy).toBeUndefined();
    });

    it("preserves non-loopback (corporate/remote) proxy when no explicit proxy is configured", () => {
      const baseEnv: NodeJS.ProcessEnv = {
        HTTP_PROXY: "http://proxy.corp.internal:8080",
        HTTPS_PROXY: "http://proxy.corp.internal:8080",
      };
      const resolved = resolveAntigravityEnvironment(baseEnv);
      expect(resolved.HTTP_PROXY).toBe("http://proxy.corp.internal:8080");
      expect(resolved.HTTPS_PROXY).toBe("http://proxy.corp.internal:8080");
    });

    it("applies proxy options configured on the AntigravityAdapter constructor", () => {
      const adapter = new AntigravityAdapter({
        proxy: "direct",
        environment: { HTTP_PROXY: "http://127.0.0.1:8888" },
      });
      expect(adapter).toBeDefined();
    });
  });

  describe("isLoopbackProxy", () => {
    it("identifies IPv4 loopback addresses", () => {
      expect(isLoopbackProxy("http://127.0.0.1:8888")).toBe(true);
      expect(isLoopbackProxy("http://127.0.0.1:8888/")).toBe(true);
      expect(isLoopbackProxy("https://127.0.0.1:8888")).toBe(true);
      expect(isLoopbackProxy("127.0.0.1:8888")).toBe(true);
      expect(isLoopbackProxy("http://127.0.0.1")).toBe(true);
      expect(isLoopbackProxy("http://0.0.0.0:8888")).toBe(true);
    });

    it("identifies localhost addresses", () => {
      expect(isLoopbackProxy("http://localhost:7890")).toBe(true);
      expect(isLoopbackProxy("http://localhost:8888/")).toBe(true);
      expect(isLoopbackProxy("localhost:8888")).toBe(true);
      expect(isLoopbackProxy("http://localhost")).toBe(true);
    });

    it("identifies IPv6 loopback addresses", () => {
      expect(isLoopbackProxy("http://[::1]:8888")).toBe(true);
      expect(isLoopbackProxy("http://[::1]:8888/")).toBe(true);
      expect(isLoopbackProxy("[::1]:8888")).toBe(true);
    });

    it("identifies socks loopback addresses", () => {
      expect(isLoopbackProxy("socks5://127.0.0.1:1080")).toBe(true);
      expect(isLoopbackProxy("socks5h://127.0.0.1:1080")).toBe(true);
    });

    it("rejects non-loopback external and corporate proxies", () => {
      expect(isLoopbackProxy("http://proxy.corp.internal:8080")).toBe(false);
      expect(isLoopbackProxy("http://10.0.0.1:8888")).toBe(false);
      expect(isLoopbackProxy("http://192.168.1.1:7890")).toBe(false);
      expect(isLoopbackProxy("https://example.com:443")).toBe(false);
    });

    it("handles falsy and empty inputs safely", () => {
      expect(isLoopbackProxy(undefined)).toBe(false);
      expect(isLoopbackProxy("")).toBe(false);
      expect(isLoopbackProxy("   ")).toBe(false);
    });
  });

  describe("isTransientNetworkError", () => {
    it("matches connection reset by peer error patterns", () => {
      expect(
        isTransientNetworkError(
          'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 127.0.0.1:62464->127.0.0.1:8888: read: connection reset by peer',
        ),
      ).toBe(true);
      expect(isTransientNetworkError("read: connection reset by peer")).toBe(true);
      expect(isTransientNetworkError("Error: ECONNRESET")).toBe(true);
      expect(isTransientNetworkError("write: broken pipe")).toBe(true);
      expect(isTransientNetworkError("unexpected EOF while reading HTTP response")).toBe(true);
      expect(isTransientNetworkError("net/http: TLS handshake timeout")).toBe(true);
    });

    it("does not match non-transient errors", () => {
      expect(isTransientNetworkError("User authentication failed: invalid token")).toBe(false);
      expect(isTransientNetworkError("Permission denied for write_to_file")).toBe(false);
      expect(isTransientNetworkError("Model gemini-pro not found")).toBe(false);
      expect(isTransientNetworkError("Context window exceeded maximum limit")).toBe(false);
    });
  });

  describe("Turn Auto-Retry on Transient Network Reset", () => {
    it("transparently retries and succeeds when attempt 1 hits connection reset in result event", async () => {
      const { command, cwd, cleanup } = await fakeResilientAgy(`
        if (attempt === 1) {
          process.stdout.write(JSON.stringify({
            event: "init",
            conversation_id: "conv-retry-1"
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conv-retry-1",
              num_turns: 1,
              status: "ERROR",
              error: "API error (attempt 1): request failed: Post \\"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\\": read tcp 127.0.0.1:62464->127.0.0.1:8888: read: connection reset by peer"
            }
          }) + "\\n");
          process.exit(0);
        } else {
          process.stdout.write(JSON.stringify({
            event: "init",
            conversation_id: "conv-retry-1"
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conv-retry-1",
              step_index: 1,
              state: "ACTIVE",
              step_type: "agent_response",
              text_delta: "Recovered from reset!"
            }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conv-retry-1",
              status: "SUCCESS",
              num_turns: 1,
              response: "Recovered from reset!"
            }
          }) + "\\n");
          process.exit(0);
        }
      `);

      const adapter = new AntigravityAdapter({ command, retryDelayMs: 10 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-1");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Test transient retry" }],
        });
        expect(executed.ok).toBe(true);

        // Turn started
        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        // Init event from attempt 1
        const stateChanged1 = await nextEvent(iterator);
        expect(stateChanged1.type).toBe("session.state.changed");

        // Attempt 1 fails in handleResult -> auto-retries -> attempt 2 init
        const stateChanged2 = await nextEvent(iterator);
        expect(stateChanged2.type).toBe("session.state.changed");

        // Item started for agentMessage
        const itemStarted = await nextEvent(iterator);
        expect(itemStarted).toMatchObject({
          type: "item.started",
          turnId,
          item: { type: "agentMessage", text: "Recovered from reset!" },
        });

        // Item completed
        const itemCompleted = await nextEvent(iterator);
        expect(itemCompleted).toMatchObject({
          type: "item.completed",
          turnId,
          snapshot: {
            item: { type: "agentMessage", text: "Recovered from reset!" },
            outcome: { status: "succeeded" },
          },
        });

        // Turn completed with success
        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
        });
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("transparently retries and succeeds when attempt 1 exits with code 1 and reset in stderr", async () => {
      const { command, cwd, cleanup } = await fakeResilientAgy(`
        if (attempt === 1) {
          process.stderr.write("read tcp 127.0.0.1:62464->127.0.0.1:8888: read: connection reset by peer\\n");
          process.exit(1);
        } else {
          process.stdout.write(JSON.stringify({
            event: "init",
            conversation_id: "conv-retry-stderr"
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conv-retry-stderr",
              step_index: 1,
              state: "ACTIVE",
              step_type: "agent_response",
              text_delta: "Succeeded on attempt 2"
            }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conv-retry-stderr",
              status: "SUCCESS",
              num_turns: 1,
              response: "Succeeded on attempt 2"
            }
          }) + "\\n");
          process.exit(0);
        }
      `);

      const adapter = new AntigravityAdapter({ command, retryDelayMs: 10 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-2");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Test stderr retry" }],
        });
        expect(executed.ok).toBe(true);

        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        const stateChanged = await nextEvent(iterator);
        expect(stateChanged.type).toBe("session.state.changed");

        const itemStarted = await nextEvent(iterator);
        expect(itemStarted.type).toBe("item.started");

        const itemCompleted = await nextEvent(iterator);
        expect(itemCompleted.type).toBe("item.completed");

        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
        });
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("stops after 1 retry and fails if error persists", async () => {
      const { command, cwd, directory, cleanup } = await fakeResilientAgy(`
        process.stdout.write(JSON.stringify({
          event: "init",
          conversation_id: "conv-persistent-fail"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-persistent-fail",
            num_turns: 1,
            status: "ERROR",
            error: "read tcp 127.0.0.1:62464->127.0.0.1:8888: read: connection reset by peer"
          }
        }) + "\\n");
        process.exit(0);
      `);

      const adapter = new AntigravityAdapter({ command, retryDelayMs: 10 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-3");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Test persistent failure" }],
        });
        expect(executed.ok).toBe(true);

        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        // 2 init events (attempt 1 and attempt 2)
        await nextEvent(iterator);
        await nextEvent(iterator);

        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "failed" },
        });

        // Verify that exactly 2 attempts were executed
        const attempts = parseInt(await readFile(path.join(directory, "attempt.txt"), "utf8"), 10);
        expect(attempts).toBe(2);
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("does not retry on non-transient errors", async () => {
      const { command, cwd, directory, cleanup } = await fakeResilientAgy(`
        process.stdout.write(JSON.stringify({
          event: "init",
          conversation_id: "conv-quota-fail"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-quota-fail",
            num_turns: 1,
            status: "ERROR",
            error: "Resource exhausted: Quota limit reached for gemini-3.7-pro"
          }
        }) + "\\n");
        process.exit(0);
      `);

      const adapter = new AntigravityAdapter({ command, retryDelayMs: 10 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-4");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Test quota failure" }],
        });
        expect(executed.ok).toBe(true);

        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        // Only 1 init event
        await nextEvent(iterator);

        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "failed" },
        });

        // Exactly 1 attempt ran (no retry)
        const attempts = parseInt(await readFile(path.join(directory, "attempt.txt"), "utf8"), 10);
        expect(attempts).toBe(1);
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("does not retry if tokens were already streamed (pre-token invariant)", async () => {
      const { command, cwd, directory, cleanup } = await fakeResilientAgy(`
        process.stdout.write(JSON.stringify({
          event: "init",
          conversation_id: "conv-post-token"
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conv-post-token",
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "I have started generating content..."
          }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-post-token",
            num_turns: 1,
            status: "ERROR",
            error: "read tcp 127.0.0.1:62464->127.0.0.1:8888: read: connection reset by peer"
          }
        }) + "\\n");
        process.exit(0);
      `);

      const adapter = new AntigravityAdapter({ command, retryDelayMs: 10 });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const turnId = hostTurnIdSchema.parse("turn-5");

        const executed = await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Test pre-token boundary" }],
        });
        expect(executed.ok).toBe(true);

        const turnStarted = await nextEvent(iterator);
        expect(turnStarted).toEqual({ type: "turn.started", turnId });

        // Init event
        await nextEvent(iterator);

        // Item started (tokens arrived!)
        const itemStarted = await nextEvent(iterator);
        expect(itemStarted.type).toBe("item.started");

        // When turn fails after item is started, active.agentItem is completed with failure
        const itemCompleted = await nextEvent(iterator);
        expect(itemCompleted.type).toBe("item.completed");

        // Turn failed without retry because text had already been emitted
        const turnCompleted = await nextEvent(iterator);
        expect(turnCompleted).toMatchObject({
          type: "turn.completed",
          turnId,
          outcome: { status: "failed" },
        });

        const attempts = parseInt(await readFile(path.join(directory, "attempt.txt"), "utf8"), 10);
        expect(attempts).toBe(1);
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
