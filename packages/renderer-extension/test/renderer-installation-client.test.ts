import {
  HARNESS_INSTALLATION_METHOD,
  HARNESS_INSTALLATION_START_METHOD,
  HARNESS_INSTALLATION_STATUS_METHOD,
  harnessIdSchema,
  type HarnessInstallationTask,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { createRendererModelClient } from "../src/renderer-model-client.js";
import { runRendererInstallation } from "../src/renderer-installation-client.js";

const result = {
  currentVersion: "1.1.0",
  latestVersion: "1.1.0",
  updateAvailable: false,
  canUpdate: true,
};
const taskId = "00000000-0000-4000-8000-000000000001";

describe("Renderer background installation requests", () => {
  it("leaves ordinary request capacity available while more updates than native slots are running", async () => {
    const completion = Promise.withResolvers<typeof result>();
    const tasks = new Map<string, HarnessInstallationTask>();
    let active = 0;
    let startedUpdates = 0;
    const queue: Array<() => void> = [];
    // Desktop's ordinary requests have five shared in-flight slots. A long
    // installation RPC in every slot also holds config reads needed by chat.
    const pump = () => {
      while (active < 5 && queue.length) queue.shift()?.();
    };
    const dispatch = vi.fn(async (method: string, params: unknown) => {
      if (method === HARNESS_INSTALLATION_METHOD) {
        startedUpdates++;
        return completion.promise;
      }
      if (method === HARNESS_INSTALLATION_START_METHOD) {
        const id = `00000000-0000-4000-8000-${String(++startedUpdates).padStart(12, "0")}`;
        const task: HarnessInstallationTask = { taskId: id, status: "running" };
        tasks.set(id, task);
        void completion.promise.then((result) =>
          tasks.set(id, { taskId: id, status: "succeeded", result }),
        );
        return task;
      }
      if (method === HARNESS_INSTALLATION_STATUS_METHOD)
        return tasks.get((params as { taskId: string }).taskId);
      return { accepted: true };
    });
    const sendRequest = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        queue.push(() => {
          active++;
          void dispatch(method, params)
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        });
        pump();
      });
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client?.installation) throw new Error("Missing installation client");
    const updates = [
      "pi",
      "claude-code",
      "grok",
      "omp",
      "opencode",
      "cursor-cli",
      "qoder",
      "kimi-code",
    ].map((id) =>
      client.installation?.({ harnessId: harnessIdSchema.parse(id), action: "update" }),
    );
    let chatAccepted = false;
    const chat = sendRequest("config/read", {})
      .then(() => sendRequest("turn/start", { threadId: "native-thread" }))
      .then(() => {
        chatAccepted = true;
      });
    try {
      await vi.waitFor(() => expect(startedUpdates).toBe(8));
      await vi.waitFor(() => expect(chatAccepted).toBe(true));
      expect([...tasks.values()].every((task) => task.status === "running")).toBe(true);
      expect(active).toBe(0);
      expect(dispatch.mock.calls.some(([method]) => method === HARNESS_INSTALLATION_METHOD)).toBe(
        false,
      );
    } finally {
      completion.resolve(result);
      await Promise.all([...updates, chat]);
    }
  });

  it("uses short background requests for polling and retains Host failure codes", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ taskId, status: "running" })
      .mockResolvedValueOnce({
        taskId,
        status: "failed",
        error: { code: -32078, message: "Unavailable on this Host" },
      });
    await expect(
      runRendererInstallation(send, { harnessId: harnessIdSchema.parse("pi"), action: "update" }),
    ).rejects.toMatchObject({ code: -32078 });
    expect(send).toHaveBeenNthCalledWith(
      2,
      HARNESS_INSTALLATION_STATUS_METHOD,
      { taskId },
      { priority: "background", timeoutMs: 15_000 },
    );
  });

  it("does not fall back to a long RPC on an old Host", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Method not found"), { code: -32601 }));
    await expect(
      runRendererInstallation(send, { harnessId: harnessIdSchema.parse("pi"), action: "update" }),
    ).rejects.toMatchObject({ code: -32601 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(HARNESS_INSTALLATION_START_METHOD);
  });

  it("rejects a status response for a different operation", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ taskId, status: "running" })
      .mockResolvedValueOnce({
        taskId: "00000000-0000-4000-8000-000000000002",
        status: "succeeded",
        result,
      });
    await expect(
      runRendererInstallation(send, { harnessId: harnessIdSchema.parse("pi"), action: "check" }),
    ).rejects.toThrow("identity changed");
  });
});
