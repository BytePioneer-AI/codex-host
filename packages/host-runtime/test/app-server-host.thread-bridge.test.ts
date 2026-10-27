import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOST_IDENTITY_METHOD,
  DELEGATION_READ_METHOD,
  DELEGATION_SEND_METHOD,
  THREAD_BRIDGE_ATTACH_METHOD,
  THREAD_BRIDGE_READ_METHOD,
  THREAD_BRIDGE_REPLY_METHOD,
  threadBridgeReadSchema,
} from "@codexhost/shared-contracts";
import { ThreadBridge } from "../src/thread-bridge.js";
import { ThreadSendReceipts } from "../src/thread-send-receipts.js";
import {
  createFixture,
  stopFixture,
  writeRequest,
  requestId,
  startPiThread,
  readJsonLine,
  requiredMessageId,
} from "./app-server-host-fixture.js";

it("validates identity before sending, then resumes native Codex without replacing its configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-send-"));
  const machineId = randomUUID();
  const fixture = createFixture({
    threadBridge: new ThreadBridge(machineId, new ThreadSendReceipts(directory)),
  });
  try {
    await fixture.ready;
    const params = {
      threadId: "native-thread",
      message: "continue",
      requestId: randomUUID(),
      expectedMachineId: machineId,
    };
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: DELEGATION_SEND_METHOD,
      params: { ...params, expectedMachineId: randomUUID() },
    });
    expect(await fixture.collector.waitFor((m) => requestId(m, 10))).toMatchObject({
      result: { error: { code: "INVALID_ARGUMENT" } },
    });
    expect(fixture.official.stdin.readableLength).toBe(0);
    writeRequest(fixture.desktopInput, { id: 11, method: DELEGATION_SEND_METHOD, params });
    const read = await readJsonLine(fixture.official.stdin);
    expect(read).toMatchObject({
      method: "thread/read",
      params: { threadId: params.threadId, includeTurns: true },
    });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(read),
      result: { thread: { id: params.threadId, status: { type: "idle" }, turns: [] } },
    });
    const resume = await readJsonLine(fixture.official.stdin);
    expect(resume).toMatchObject({
      method: "thread/resume",
      params: { threadId: params.threadId, excludeTurns: true },
    });
    expect(resume.params).not.toHaveProperty("approvalPolicy");
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(resume),
      result: { thread: { id: params.threadId, status: { type: "idle" }, turns: [] } },
    });
    const start = await readJsonLine(fixture.official.stdin);
    expect(start).toMatchObject({
      method: "turn/start",
      params: { threadId: params.threadId, input: [{ type: "text", text: params.message }] },
    });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(start),
      result: { turn: { id: "native-turn", status: "inProgress", items: [] } },
    });
    const reply = await fixture.collector.waitFor((m) => requestId(m, 11));
    expect(reply).toMatchObject({
      result: { result: { threadId: params.threadId, turnId: "native-turn", harnessId: "codex" } },
    });
    writeRequest(fixture.desktopInput, { id: 12, method: DELEGATION_SEND_METHOD, params });
    expect(await fixture.collector.waitFor((m) => requestId(m, 12))).toMatchObject({
      result: reply.result,
    });
    expect(fixture.official.stdin.readableLength).toBe(0);
    writeRequest(fixture.official.stdout, {
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: "native-turn", status: "completed", items: [] },
      },
    });
    await vi.waitFor(() =>
      expect(fixture.collector.messages.some((m) => m.method === "turn/completed")).toBe(true),
    );
  } finally {
    fixture.host.close();
    await stopFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
});

it("checks the destination identity before reading external Harness history", async () => {
  const machineId = "12345678-1234-4123-8123-123456789abc";
  const fixture = createFixture({ threadBridge: new ThreadBridge(machineId) });
  try {
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 20,
      method: DELEGATION_READ_METHOD,
      params: {
        threadId,
        view: "result",
        expectedMachineId: "22345678-1234-4123-8123-123456789abc",
      },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 20))).toMatchObject({
      error: { code: -32602 },
    });
    writeRequest(fixture.desktopInput, {
      id: 21,
      method: DELEGATION_READ_METHOD,
      params: { threadId, view: "result", expectedMachineId: machineId },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 21))).toMatchObject({
      result: { threadId, harnessId: "pi" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("handles bridge protocol on the Desktop session and unregisters it on disconnect", async () => {
  const machineId = "12345678-1234-4123-8123-123456789abc";
  const target = "22345678-1234-4123-8123-123456789abc";
  const clientId = "32345678-1234-4123-8123-123456789abc";
  const bridge = new ThreadBridge(machineId);
  const fixture = createFixture({ threadBridge: bridge });
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, { id: 1, method: HOST_IDENTITY_METHOD, params: {} });
    expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
      result: { machineId },
    });
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: THREAD_BRIDGE_ATTACH_METHOD,
      params: { clientId, machineIds: [target] },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toHaveProperty(
      "result",
    );
    const pending = bridge.read({ threadId: "t", machineId: target, view: "result" });
    const read = threadBridgeReadSchema.parse(
      (await fixture.collector.waitFor((message) => message.method === THREAD_BRIDGE_READ_METHOD))
        .params,
    );
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: THREAD_BRIDGE_REPLY_METHOD,
      params: {
        clientId,
        requestId: read.requestId,
        reply: {
          result: {
            threadId: "t",
            harnessId: "codex",
            status: "completed",
            turn: null,
            progress: [],
            result: { availability: "available", text: "remote result" },
            nextCursor: null,
          },
        },
      },
    });
    expect(await pending).toMatchObject({ machineId: target, result: { text: "remote result" } });
    expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toHaveProperty(
      "result",
    );
    writeRequest(fixture.desktopInput, {
      id: 4,
      method: THREAD_BRIDGE_ATTACH_METHOD,
      params: { clientId, machineIds: [target], endpoint: "http://unexpected" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
      error: { code: -32602 },
    });
    fixture.host.disconnect();
    await expect(bridge.read({ threadId: "t", machineId: target, view: "result" })).rejects.toThrow(
      "no connected",
    );
  } finally {
    await stopFixture(fixture);
  }
});
