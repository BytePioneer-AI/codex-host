import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "@codexhost/harness-broker";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

it("uses a generic Adapter's current steer capability through the Broker and Host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-steer-"));
  const descriptorPath = path.join(root, "broker.json");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-steer-${randomUUID()}`
      : path.join(root, "b.sock");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
  const broker = new BrokeredHarnessAdapter({ harnessId: "pi", descriptorPath });
  // The Host fixture's catalog stays synthetic; its Session comes from the real socket transport.
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  vi.spyOn(adapter, "open").mockImplementation((input) => broker.open(input));
  const f = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
  try {
    const threadId = await startPiThread(f);
    const turnId = await startPiTurn(f, threadId);
    const session = native.sessions[0];
    if (!session) throw new Error("Native Session was not opened");
    const execute = vi.spyOn(session, "execute");
    const inspect = async (id: number) => {
      writeRequest(f.desktopInput, {
        id,
        method: "codexhost/thread/steering/inspect",
        params: { threadId, text: "adjust" },
      });
      return f.collector.waitFor((message) => requestId(message, id));
    };
    expect(await inspect(3)).toMatchObject({ result: { delivery: "newTurn" } });
    session.capabilities.steer = true;
    expect(await inspect(4)).toMatchObject({ result: { delivery: "activeTurn" } });
    writeRequest(f.desktopInput, {
      id: 5,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: "broker-message",
        codexhostSteerDelivery: "activeTurn",
        input: [{ type: "text", text: "adjust" }],
      },
    });
    expect(await f.collector.waitFor((message) => requestId(message, 5))).toMatchObject({
      result: { turnId, delivery: "activeTurn" },
    });
    expect(session.steers).toHaveLength(1);
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.cancel" }));
    await f.collector.waitFor((message) => {
      const params = message.params as JsonObject | undefined;
      const item = params?.item as JsonObject | undefined;
      return (
        message.method === "item/started" &&
        params?.turnId === turnId &&
        item?.clientId === "broker-message"
      );
    });

    session.capabilities.steer = false;
    expect(await inspect(6)).toMatchObject({ result: { delivery: "newTurn" } });
    // An earlier GUI preflight is not permission to change delivery after native rejection.
    writeRequest(f.desktopInput, {
      id: 8,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        codexhostSteerDelivery: "activeTurn",
        input: [{ type: "text", text: "stale preflight" }],
      },
    });
    expect(await f.collector.waitFor((message) => requestId(message, 8))).toMatchObject({
      error: { code: -32074 },
    });
    expect(session.steers).toHaveLength(1);
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn.cancel" }));

    // A client without Renderer preflight also reads current remote capabilities before delivery.
    writeRequest(f.desktopInput, {
      id: 7,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: "replacement-message",
        input: [{ type: "text", text: "replace" }],
      },
    });
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.cancel" })),
    );
    session.completeCancellation();
    const replacement = await f.collector.waitFor((message) => requestId(message, 7));
    expect(replacement).toMatchObject({ result: { delivery: "newTurn" } });
    expect((replacement.result as JsonObject).turnId).not.toBe(turnId);
    expect(session.steers).toHaveLength(1);
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      "turn.steer",
      "turn.steer",
      "turn.cancel",
      "turn.start",
    ]);
    Object.assign(session, {
      readCapabilities: async () => {
        throw new Error("capability read failed");
      },
    });
    expect(await inspect(9)).toMatchObject({ error: { code: -32081 } });
  } finally {
    await stopFixture(f);
    await broker.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
