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

function adapterWithSnapshot(payloadBytes: number) {
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
          historyPayload: "x".repeat(payloadBytes),
        },
      });
    return result;
  });
  return native;
}

const snapshotLimits = [
  {
    client: "legacy Client without a declaration",
    helloOptions: {},
    responseLimit: 8 * 1024 * 1024,
    snapshotBytes: 15 * 1024 * 1024,
  },
  {
    client: "Client declaring more than the server limit",
    helloOptions: { maxResponseBytes: 2 * HARNESS_BROKER_MAX_RESPONSE_BYTES },
    responseLimit: HARNESS_BROKER_MAX_RESPONSE_BYTES,
    snapshotBytes: HARNESS_BROKER_MAX_RESPONSE_BYTES,
  },
];

it.each(snapshotLimits)("rejects oversized snapshots for $client", async (testCase) => {
  const { helloOptions, responseLimit, snapshotBytes } = testCase;
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-broker-frame-size-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-broker-size-${randomUUID()}`
      : path.join(root, "b.sock");
  const server = await startHarnessBrokerServer({
    descriptorPath: path.join(root, "broker.json"),
    socketPath,
    adapter: adapterWithSnapshot(snapshotBytes),
  });
  const socket = net.createConnection(socketPath);
  const reader = createInterface({ input: socket });
  const frames = reader[Symbol.asyncIterator]();
  const receive = async () => {
    const next = await frames.next();
    if (next.done) throw new Error("Broker disconnected instead of returning an error");
    const bytes = Buffer.byteLength(next.value) + 1;
    expect(bytes).toBeLessThanOrEqual(responseLimit);
    return {
      bytes,
      frame: JSON.parse(next.value) as {
        sequence: number;
        ok: boolean;
        value?: { status?: string; value?: { sessionId: string; sessionGeneration: number } };
        error?: { message: string };
      },
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
    send(1, { kind: "hello", token: server.descriptor.token, ...helloOptions });
    expect((await receive()).frame).toMatchObject({ sequence: 1, ok: true });
    send(2, {
      kind: "request",
      id: randomUUID(),
      method: "adapter.open",
      params: { kind: "create", cwd: root },
    });
    const opened = (await receive()).frame;
    const session = opened.value?.value;
    if (!session) throw new Error("Broker did not open a session");
    const { sessionId, sessionGeneration } = session;
    const id = randomUUID();
    send(3, {
      kind: "request",
      id,
      method: "session.readSnapshot",
      params: { sessionId, sessionGeneration },
    });
    const rejected = await receive();
    expect(rejected.bytes).toBeLessThan(1024);
    expect(rejected.frame.error?.message).toContain("frame exceeds the maximum size");
    expect(rejected.frame).toMatchObject({ id, sequence: 3, ok: false });
    send(4, { kind: "request", id: randomUUID(), method: "adapter.inspect", params: {} });
    expect((await receive()).frame).toMatchObject({
      sequence: 4,
      ok: true,
      value: { status: "ready" },
    });
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
  const server = await startHarnessBrokerServer({
    descriptorPath,
    socketPath,
    adapter: adapterWithSnapshot(15 * 1024 * 1024),
  });
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
