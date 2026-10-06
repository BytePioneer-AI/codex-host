import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { connectHost, startSyntheticHost } from "./synthetic-host.mjs";
import {
  startModelPickerProbe,
  pickerObservation,
  pickerConfigObservation,
  configureReadonlyProbe,
} from "./model-picker-probe.mjs";

it("records model selections without message contents or authorization", () => {
  expect(
    pickerObservation({
      method: "turn/start",
      params: { model: "chosen", input: [{ text: "private body" }], authorization: "secret" },
    }),
  ).toEqual({
    method: "turn/start",
    parameterKeys: ["model", "input", "authorization"],
    fields: { model: "chosen" },
  });
});

it("projects two explicit fake names and preserves submitted model fields through an isolated socket", async () => {
  const directory = await mkdtemp("/tmp/ch-picker-test-");
  const upstream = path.join(directory, "up.sock");
  const socketPath = path.join(directory, "probe.sock");
  const report = path.join(directory, "observations.jsonl");
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      socket.send(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "model/list"
              ? {
                  data: [
                    {
                      id: "native",
                      model: "native",
                      displayName: "Native",
                      supportedReasoningEfforts: [],
                      defaultReasoningEffort: "medium",
                    },
                  ],
                  nextCursor: "ignored",
                }
              : { received: request.params },
        }),
      );
    }),
  );
  let probe, client;
  try {
    await new Promise((resolve) => server.listen(upstream, resolve));
    probe = await startModelPickerProbe({
      upstream,
      socketPath,
      adapter: new FakeHarnessAdapter("pi"),
      report,
    });
    client = await connectHost(socketPath, "picker-test");
    const models = await client.request("model/list");
    expect(models.data.map((model) => model.displayName)).toEqual([
      "测试 A · 可读模型名称",
      "测试 B · 另一模型名称",
    ]);
    expect(models.nextCursor).toBeNull();
    expect(models.data[1].model).not.toBe(models.data[1].id);
    const params = {
      model: models.data[1].model,
      effort: "high",
      input: [{ type: "text", text: "private body" }],
    };
    expect((await client.request("turn/start", params)).received).toEqual(params);
    await client.close();
    client = undefined;
    await probe.close();
    probe = undefined;
    const recorded = await readFile(report, "utf8");
    expect(recorded).toContain(models.data[1].model);
    expect(recorded).not.toContain("private body");
  } finally {
    await client?.close();
    await probe?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

it("completes the real Host handshake through the probe using text WebSocket frames", async () => {
  let host, probe, client;
  try {
    host = await startSyntheticHost({
      onReady: async (upstream, adapter) => {
        probe = await startModelPickerProbe({
          upstream,
          adapter,
          socketPath: path.join(path.dirname(upstream), "probe.sock"),
          report: path.join(path.dirname(upstream), "probe.jsonl"),
        });
      },
    });
    client = await connectHost(
      path.join(host.directory, "probe.sock"),
      "phone-handshake-regression",
    );
    const result = await client.request("thread/read", {
      threadId: host.threadId,
      includeTurns: true,
    });
    expect(result.thread.id).toBe(host.threadId);
  } finally {
    await client?.close();
    await probe?.close();
    await host?.close();
  }
});

it("records configuration structure without unrelated config secrets", () => {
  const observation = pickerConfigObservation({
    config: {
      model: "test",
      sandbox_mode: "read-only",
      api_key: "secret",
      projects: { "/private/example": { trust_level: "untrusted" } },
    },
    layers: [{ name: { type: "user", file: "/private/config" }, config: { secret: "hidden" } }],
  });
  expect(observation.sandboxMode).toBe("read-only");
  expect(observation.projectTrust).toEqual(["untrusted"]);
  expect(JSON.stringify(observation)).not.toMatch(/secret|private|hidden/);
});

it("stops before pairing if the restrictive config is not effective", async () => {
  const requests = [];
  const native = {
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "config/batchWrite"
        ? { status: "ok" }
        : { config: { sandbox_mode: "workspace-write" } };
    },
  };
  await expect(configureReadonlyProbe(native, "/synthetic")).rejects.toThrow("not effective");
  expect(requests[0].params.edits).toEqual([
    { keyPath: "sandbox_mode", mergeStrategy: "replace", value: "read-only" },
  ]);
});
