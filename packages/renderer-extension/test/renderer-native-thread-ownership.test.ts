import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { createRendererModelClient, THREAD_INSPECT_METHOD } from "../src/renderer-model-client.js";

const threadId = hostThreadIdSchema.parse("remote-native-thread");
const nativeThread = { id: threadId, modelProvider: "custom", cliVersion: "0.151.0" };
const unsupported = {
  code: -32600,
  message:
    "Invalid request: unknown variant `codexhost/thread/inspect`, expected one of `thread/read`",
};

function setup(error: unknown = unsupported, response: unknown = { thread: nativeThread }) {
  const sendRequest = vi
    .fn<(method: string, params: unknown) => Promise<unknown>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(response);
  const client = createRendererModelClient([{ sendRequest }]);
  if (!client) throw new Error("Synthetic remote client was not created");
  return { client, sendRequest };
}

describe("native Thread ownership without the codexhost inspection API", () => {
  it.each([
    unsupported,
    { code: -32601, message: "Method not found" },
    Object.assign(new Error(unsupported.message), { jsonRpcCode: -32600 }),
    Object.assign(new Error("Method not found"), { jsonRpcCode: -32601 }),
  ])(
    "verifies the native Thread on the same connection when inspection is unsupported: %j",
    async (error) => {
      const { client, sendRequest } = setup(error);
      await expect(client.inspectThread({ threadId })).resolves.toEqual({
        owner: "codex",
        locked: true,
      });
      expect(sendRequest.mock.calls).toEqual([
        [THREAD_INSPECT_METHOD, { threadId }],
        ["thread/read", { threadId, includeTurns: false }],
      ]);
    },
  );

  it.each([
    new Error("connection closed"),
    new Error("Method not found"),
    { code: -32000, message: "request timed out" },
    { code: -32600, message: "Invalid request: invalid params" },
    { code: -32600, message: "Invalid request: unknown variant `codexhost/thread/usage/inspect`" },
    Object.assign(new Error("unauthorized"), { jsonRpcCode: -32001 }),
    Object.assign(new Error("connection closed"), { jsonRpcCode: -32000 }),
    Object.assign(new Error("Invalid request: invalid params"), { jsonRpcCode: -32600 }),
    Object.assign(new Error("Invalid request: unknown variant `codexhost/thread/usage/inspect`"), {
      jsonRpcCode: -32600,
    }),
  ])("does not bypass an ordinary inspection failure: %j", async (error) => {
    const { client, sendRequest } = setup(error);
    await expect(client.inspectThread({ threadId })).rejects.toBe(error);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { thread: { ...nativeThread, id: "another-thread" } },
    { thread: { ...nativeThread, modelProvider: "codexhost" } },
    { thread: { ...nativeThread, cliVersion: "codexhost" } },
    { thread: { id: threadId } },
    { thread: { ...nativeThread, modelProvider: "" } },
    { thread: { ...nativeThread, cliVersion: "" } },
    {},
    null,
  ])(
    "does not classify an external or unconfirmed native response as Codex: %j",
    async (response) => {
      const { client } = setup(unsupported, response);
      await expect(client.inspectThread({ threadId })).rejects.toThrow(/ownership/);
    },
  );

  it("propagates failure of the native read instead of inventing ownership", async () => {
    const { client, sendRequest } = setup();
    sendRequest
      .mockReset()
      .mockRejectedValueOnce(unsupported)
      .mockRejectedValueOnce(new Error("Thread not found"));
    await expect(client.inspectThread({ threadId })).rejects.toThrow("Thread not found");
  });

  it("does not replace an invalid extension result with native ownership", async () => {
    const { client, sendRequest } = setup();
    sendRequest.mockReset().mockResolvedValueOnce({ owner: "unknown" });
    await expect(client.inspectThread({ threadId })).rejects.toThrow();
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
});
