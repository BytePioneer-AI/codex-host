import {
  harnessIdSchema,
  hostThreadIdSchema,
  harnessModelRefSchema,
  type HarnessInspection,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRendererModelClient,
  CODEX_ACCOUNT_LIST_METHOD,
  HARNESS_INSPECT_METHOD,
  THREAD_INSPECT_METHOD,
} from "../src/renderer-model-client.js";

const unsupported = (method: string) =>
  Object.assign(new Error(`Invalid request: unknown variant \`${method}\``), { code: -32600 });
const threadId = hostThreadIdSchema.parse("native-thread");
const missingHarness = {
  status: "notInstalled",
  error: { code: "notInstalled", message: "not installed", retryable: false },
};
const usage = { threadId, usage: null };
const readyHarness: HarnessInspection = {
  status: "ready",
  catalog: {
    models: [
      {
        ref: harnessModelRefSchema.parse({ id: "synthetic" }),
        label: "Native model",
        supportedThinkingOptionIds: [],
      },
    ],
    defaultModel: harnessModelRefSchema.parse({ id: "synthetic" }),
    thinkingOptions: [],
  },
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
  },
};

function clientFor(sendRequest: (method: string, params: unknown) => Promise<unknown>) {
  const client = createRendererModelClient([{ sendRequest }]);
  if (!client) throw new Error("Synthetic client unavailable");
  return client;
}

describe("unsupported methods on one Host connection", () => {
  it("does not send a known unsupported method again, even with different Harness params", async () => {
    const sendRequest = vi.fn(async (method: string) => {
      throw unsupported(method);
    });
    const client = clientFor(sendRequest);
    for (const harnessId of ["pi", "claude-code", "pi"]) {
      await expect(
        client.inspectHarness({ harnessId: harnessIdSchema.parse(harnessId), refresh: true }),
      ).rejects.toThrow();
    }
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it("an unsupported Account API does not suppress Harness discovery, usage, or another Host", async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === CODEX_ACCOUNT_LIST_METHOD) throw unsupported(method);
      if (method === HARNESS_INSPECT_METHOD) return readyHarness;
      return usage;
    });
    const client = clientFor(sendRequest);
    for (let i = 0; i < 3; i++) await expect(client.listCodexAccounts()).rejects.toThrow();
    for (const harnessId of ["pi", "claude-code"]) {
      await expect(
        client.inspectHarness({ harnessId: harnessIdSchema.parse(harnessId) }),
      ).resolves.toEqual(readyHarness);
    }
    await expect(client.inspectThreadUsage({ threadId })).resolves.toEqual(usage);
    const otherHost = clientFor(async () => ({ accounts: [] }));
    await expect(otherHost.listCodexAccounts()).resolves.toEqual({ accounts: [] });
    expect(sendRequest.mock.calls.filter(([m]) => m === CODEX_ACCOUNT_LIST_METHOD)).toHaveLength(1);
    expect(sendRequest.mock.calls.filter(([m]) => m === HARNESS_INSPECT_METHOD)).toHaveLength(2);
  });

  it("a missing Harness does not disable discovery of other installed Harnesses", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(missingHarness)
      .mockResolvedValue(readyHarness);
    const client = clientFor(sendRequest);
    await expect(
      client.inspectHarness({ harnessId: harnessIdSchema.parse("grok") }),
    ).resolves.toEqual(missingHarness);
    for (const harnessId of ["pi", "claude-code"]) {
      await expect(
        client.inspectHarness({ harnessId: harnessIdSchema.parse(harnessId) }),
      ).resolves.toEqual(readyHarness);
    }
    expect(sendRequest).toHaveBeenCalledTimes(3);
  });

  it("keeps supported requests concurrent and does not cache their results", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendRequest = vi.fn(async () => {
      await pending;
      return readyHarness;
    });
    const client = clientFor(sendRequest);
    const requests = ["pi", "claude-code"].map((id) =>
      client.inspectHarness({ harnessId: harnessIdSchema.parse(id) }),
    );
    expect(sendRequest).toHaveBeenCalledTimes(2);
    release?.();
    await Promise.all(requests);
    await client.inspectHarness({ harnessId: harnessIdSchema.parse("pi"), refresh: true });
    expect(sendRequest).toHaveBeenCalledTimes(3);
  });

  it.each([
    new Error("Method not found"),
    Object.assign(new Error("timeout"), { code: -32000 }),
    Object.assign(new Error("unauthorized"), { code: -32001 }),
    Object.assign(new Error("Invalid request: unknown variant `some-param`"), { code: -32600 }),
  ])("retains recovery after a transient, auth, or parameter error: %s", async (error) => {
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ accounts: [] });
    const client = clientFor(sendRequest);
    await expect(client.listCodexAccounts()).rejects.toBe(error);
    await expect(client.listCodexAccounts()).resolves.toEqual({ accounts: [] });
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("a replacement connection rechecks methods that were unsupported", async () => {
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(unsupported(CODEX_ACCOUNT_LIST_METHOD))
      .mockResolvedValueOnce({ accounts: [] });
    await expect(clientFor(sendRequest).listCodexAccounts()).rejects.toThrow();
    await expect(clientFor(sendRequest).listCodexAccounts()).resolves.toEqual({ accounts: [] });
  });

  it("skips repeat unsupported inspections but still verifies every native Thread", async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === THREAD_INSPECT_METHOD) throw unsupported(method);
      return { thread: { id: threadId, modelProvider: "custom", cliVersion: "0.151.0" } };
    });
    const client = clientFor(sendRequest);
    for (let i = 0; i < 3; i++)
      await expect(client.inspectThread({ threadId })).resolves.toEqual({
        owner: "codex",
        locked: true,
      });
    expect(sendRequest.mock.calls.map(([m]) => m)).toEqual([
      THREAD_INSPECT_METHOD,
      "thread/read",
      "thread/read",
      "thread/read",
    ]);
  });
});
