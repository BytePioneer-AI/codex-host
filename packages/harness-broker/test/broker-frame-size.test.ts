import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";
import { HARNESS_BROKER_MAX_RESPONSE_BYTES } from "../src/protocol.js";

it("returns an oversized-response error without skipping a broker sequence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-broker-frame-size-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-broker-size-${randomUUID()}`
      : path.join(root, "b.sock");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const baseline = await native.inspect();
  vi.spyOn(native, "inspect").mockResolvedValueOnce(
    Object.assign({}, baseline, {
      oversizedFixture: "x".repeat(HARNESS_BROKER_MAX_RESPONSE_BYTES),
    }),
  );
  const server = await startHarnessBrokerServer({
    descriptorPath: path.join(root, "broker.json"),
    socketPath,
    adapter: native,
  });
  const socket = net.createConnection(socketPath);
  const reader = createInterface({ input: socket });
  const frames = reader[Symbol.asyncIterator]();
  const receive = async () => {
    const next = await frames.next();
    if (next.done) throw new Error("Broker disconnected instead of returning an error");
    return JSON.parse(next.value) as {
      sequence: number;
      ok: boolean;
      value?: { status?: string };
      error?: { message: string };
    };
  };
  const send = (sequence: number, payload: object) =>
    socket.write(
      JSON.stringify({
        version: 1,
        generation: server.descriptor.generation,
        sequence,
        ...payload,
      }) + "\n",
    );
  try {
    await once(socket, "connect");
    send(1, { kind: "hello", token: server.descriptor.token });
    expect(await receive()).toMatchObject({ sequence: 1, ok: true });
    send(2, { kind: "request", id: randomUUID(), method: "adapter.inspect", params: {} });
    const rejected = await receive();
    expect(rejected.error?.message).toContain("frame exceeds the maximum size");
    expect(rejected.sequence).toBe(2);
    send(3, { kind: "request", id: randomUUID(), method: "adapter.inspect", params: {} });
    expect(await receive()).toMatchObject({ sequence: 3, ok: true, value: { status: "ready" } });
  } finally {
    reader.close();
    socket.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reads a large native snapshot and keeps its broker connection usable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-broker-large-history-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-broker-history-${randomUUID()}`
      : path.join(root, "b.sock");
  const descriptorPath = path.join(root, "broker.json");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const open = native.open.bind(native);
  vi.spyOn(native, "open").mockImplementation(async (input) => {
    const result = await open(input);
    if (result.ok)
      result.value.readSnapshot = async () => ({
        ok: true,
        value: {
          turns: [],
          state: result.value.initialState,
          historyPayload: "x".repeat(15 * 1024 * 1024),
        },
      });
    return result;
  });
  const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
  const client = new BrokeredHarnessAdapter({ descriptorPath });
  try {
    const opened = await client.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(opened.error.message);
    const snapshot = await opened.value.readSnapshot?.();
    expect(snapshot?.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(8 * 1024 * 1024);
    await expect(client.inspect()).resolves.toMatchObject({ status: "ready" });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
