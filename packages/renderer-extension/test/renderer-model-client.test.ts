import { harnessModelRefSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  HARNESS_INSPECT_METHOD,
  THREAD_INSPECT_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  createRendererModelClient,
} from "../src/renderer-model-client.js";

const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });
const inspection = {
  status: "ready" as const,
  catalog: {
    models: [{ ref: model, label: "provider / model" }],
    defaultModel: model,
  },
  capabilities: {
    configuration: { selectModel: true },
    history: { fork: true },
  },
};

describe("Renderer fixed Model request client", () => {
  it("calls only the fixed inspect and select methods with validated params", async () => {
    const sendRequest = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(inspection)
      .mockResolvedValueOnce({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: model,
        locked: true,
      })
      .mockResolvedValueOnce({ effectiveModel: model });
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(client.inspectPi({ harnessId: "pi", refresh: true })).resolves.toEqual(inspection);
    await expect(
      client.inspectThread({ threadId: hostThreadIdSchema.parse("thread-1") }),
    ).resolves.toMatchObject({ owner: "external", harnessId: "pi", locked: true });
    await expect(
      client.selectPiThreadModel({
        threadId: hostThreadIdSchema.parse("thread-1"),
        model,
      }),
    ).resolves.toEqual({ effectiveModel: model });
    expect(sendRequest).toHaveBeenNthCalledWith(1, HARNESS_INSPECT_METHOD, {
      harnessId: "pi",
      refresh: true,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, THREAD_INSPECT_METHOD, {
      threadId: "thread-1",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(3, THREAD_MODEL_SELECT_METHOD, {
      threadId: "thread-1",
      model,
    });
  });

  it("fails closed when request manager ownership is absent or ambiguous", () => {
    expect(createRendererModelClient([])).toBeNull();
    expect(
      createRendererModelClient([{ sendRequest: vi.fn() }, { sendRequest: vi.fn() }]),
    ).toBeNull();
    expect(createRendererModelClient([{}])).toBeNull();
  });

  it("rejects a Thread inspection that leaks Native identity", async () => {
    const sendRequest = vi.fn(async () => ({
      owner: "external",
      harnessId: "pi",
      transportModelId: "codexhost/pi-native",
      locked: true,
      nativeSessionRef: { nativeSessionId: "private" },
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(
      client.inspectThread({ threadId: hostThreadIdSchema.parse("thread-1") }),
    ).rejects.toThrow();
  });

  it("rejects a response that leaks undeclared native Model fields", async () => {
    const sendRequest = vi.fn(async () => ({
      ...inspection,
      catalog: {
        ...inspection.catalog,
        models: [
          {
            ref: model,
            label: "provider / model",
            provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
          },
        ],
      },
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(client.inspectPi({ harnessId: "pi" })).rejects.toThrow();
  });
});
