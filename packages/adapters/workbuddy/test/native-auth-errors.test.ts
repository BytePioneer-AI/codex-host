import { describe, expect, it } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

async function failedTurn(errorMessage?: unknown) {
  const adapter = new WorkBuddyAdapter({
    environment: {},
    readHistory: async () => "",
    clientFactory: () => ({
      initialize: async () => ({ protocolVersion: 1 }),
      open: async () => ({
        sessionId: "native-auth-failure",
        configOptions: [
          {
            id: "model",
            currentValue: "native/model",
            options: [{ value: "native/model", name: "Native Model" }],
          },
          {
            id: "mode",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }],
          },
          {
            id: "thought_level",
            currentValue: "low",
            options: [{ value: "low", name: "Low" }],
          },
        ],
      }),
      configure: async () => ({}),
      prompt: async () => ({
        stopReason: "refusal",
        _meta: {
          "codebuddy.ai/outcome": "FAILED_MODEL_REQUEST",
          "codebuddy.ai/errorMessage": errorMessage,
        },
      }),
      cancel: async () => {},
      answer: async () => {},
      close: async () => {},
    }),
  });
  const outputs: HarnessOutput[] = [];
  try {
    const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment: {} });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value;
    const collected = (async () => {
      for await (const output of session.outputs) {
        outputs.push(output);
        if (output.kind === "event" && output.event.type === "turn.completed")
          return output.event.outcome;
      }
      throw Error("Session closed without a terminal Turn");
    })();
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("auth-turn"),
        input: [{ type: "text", text: "1+1" }],
      }),
    ).toMatchObject({ ok: true });
    return { outcome: await collected, outputs };
  } finally {
    await adapter.close();
  }
}

describe("WorkBuddy native Turn errors", () => {
  it("preserves the native authentication category and login instruction from ACP metadata", async () => {
    // WorkBuddy's bundled CLI returns a successful RPC containing this failed outcome.
    const details = "Authentication required. Please use /login command to sign in to your account";
    const { outcome, outputs } = await failedTurn(
      JSON.stringify({
        code: -32000,
        message: "Authentication required",
        data: { category: "auth", details },
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "authenticationRequired",
        message: expect.stringContaining(details),
        retryable: false,
      },
    });
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed"),
    ).toHaveLength(1);
  });

  it("recognizes an auth category without depending on English error text", async () => {
    const { outcome } = await failedTurn(
      JSON.stringify({ code: -32000, message: "请重新登录", data: { category: "auth" } }),
    );
    expect(outcome).toMatchObject({
      error: { code: "authenticationRequired", message: expect.stringContaining("请重新登录") },
    });
  });

  it("keeps non-auth refusals as native failures even with RPC code -32000", async () => {
    const { outcome } = await failedTurn(
      JSON.stringify({ code: -32000, message: "Request blocked", data: { category: "policy" } }),
    );
    expect(outcome).toMatchObject({
      error: { code: "nativeFailure", message: expect.stringContaining("Request blocked") },
    });
  });

  it("sanitizes the extracted diagnostic before publishing it", async () => {
    const { outcome } = await failedTurn(
      JSON.stringify({ message: "Request failed Authorization: Bearer test-secret-value" }),
    );
    expect(outcome).toMatchObject({
      error: { message: expect.stringContaining("Request failed") },
    });
    expect(JSON.stringify(outcome)).not.toContain("test-secret-value");
  });

  it("preserves plain-text errors from older native versions", async () => {
    const { outcome } = await failedTurn("Upstream model unavailable");
    expect(outcome).toMatchObject({
      error: {
        code: "nativeFailure",
        message: expect.stringContaining("Upstream model unavailable"),
      },
    });
  });

  it.each([undefined, "", "{}", "[]", "null", 42])(
    "retains the terminal fallback when metadata has no diagnostic: %j",
    async (metadata) => {
      const { outcome } = await failedTurn(metadata);
      expect(outcome).toMatchObject({
        error: {
          code: "nativeFailure",
          message: "WorkBuddy: Native Turn stopped: refusal (FAILED_MODEL_REQUEST)",
        },
      });
    },
  );
});
