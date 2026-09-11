import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net, { type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  HarnessOutputChannel,
  type HarnessOutput,
  type HarnessSession,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  harnessPermissionModeIdSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";
import { consumeBrokerFrames } from "../src/framing.js";
import { harnessBrokerServerFrameSchema } from "../src/protocol.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-recover-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const endpoint = (name: string) =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-${randomUUID()}`
      : path.join(root, name + ".sock");
  return {
    root,
    endpoint,
    descriptorPath: path.join(root, "broker.json"),
    socketPath: endpoint("broker"),
  };
}
const id = harnessIdSchema.parse("codebuddy");
describe("broker recovery ownership", () => {
  it("preserves the ownership error when closing a foreign Session rejects", async () => {
    const f = await fixture();
    const native = new FakeHarnessAdapter(id);
    const foreign = new FakeHarnessSession(harnessIdSchema.parse("foreign"));
    const close = vi.spyOn(foreign, "close").mockRejectedValueOnce(new Error("cleanup failed"));
    cleanup.push(() => foreign.close());
    vi.spyOn(native, "open").mockResolvedValueOnce({ ok: true, value: foreign });
    const server = await startHarnessBrokerServer({ ...f, adapter: native });
    cleanup.push(() => server.close());
    const client = new BrokeredHarnessAdapter({ harnessId: id, descriptorPath: f.descriptorPath });
    cleanup.push(() => client.close());

    await expect(client.open({ kind: "create", cwd: f.root })).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError", message: "Adapter opened a Session for another Harness" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect((await client.open({ kind: "create", cwd: f.root })).ok).toBe(true);
  });
  it("does not invent a replacement native Session when create had not confirmed identity", async () => {
    const f = await fixture();
    let native = new FakeHarnessAdapter(id);
    const open = native.open.bind(native);
    vi.spyOn(native, "open").mockImplementation(async (input) => {
      const result = await open(input);
      if (result.ok) Object.defineProperty(result.value, "initialState", { value: {} });
      return result;
    });
    let server = await startHarnessBrokerServer({ ...f, adapter: native });
    cleanup.push(() => server.close());
    const client = new BrokeredHarnessAdapter({ harnessId: id, descriptorPath: f.descriptorPath });
    cleanup.push(() => client.close());
    const created = await client.open({ kind: "create", cwd: f.root });
    if (!created.ok) throw Error(created.error.message);
    await server.close();
    native = new FakeHarnessAdapter(id);
    const replacement = vi.spyOn(native, "open");
    server = await startHarnessBrokerServer({ ...f, adapter: native });
    const result = await created.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("after-unconfirmed"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(result).toMatchObject({ ok: false, error: { retryable: false } });
    expect(replacement).not.toHaveBeenCalled();
  });
  it("ends existing output streams when the adapter closes after losing its connection", async () => {
    const f = await fixture(),
      native = new FakeHarnessAdapter(id);
    const server = await startHarnessBrokerServer({ ...f, adapter: native });
    cleanup.push(() => server.close());
    const client = new BrokeredHarnessAdapter({ harnessId: id, descriptorPath: f.descriptorPath });
    cleanup.push(() => client.close());
    const opened = await client.open({ kind: "create", cwd: f.root });
    if (!opened.ok) throw Error(opened.error.message);
    let ended = false;
    const drained = (async () => {
      for await (const output of opened.value.outputs) void output;
      ended = true;
    })();
    await server.close();
    await client.close();
    await vi.waitFor(() => expect(ended).toBe(true));
    await drained;
  });
  it("resumes the same live wrapper after broker restart with its confirmed native state", async () => {
    const f = await fixture();
    const modes = harnessPermissionModeCatalogSchema.parse({
      defaultModeId: "ask",
      modes: [
        { id: "ask", label: "Ask" },
        { id: "plan", label: "Plan" },
      ],
    });
    let native = new FakeHarnessAdapter(id, undefined, true, true, null, modes);
    let server = await startHarnessBrokerServer({ ...f, adapter: native });
    cleanup.push(() => server.close());
    const client = new BrokeredHarnessAdapter({
      harnessId: id,
      descriptorPath: f.descriptorPath,
      forwardDelegationEnvironment: true,
    });
    cleanup.push(() => client.close());
    const created = await client.open({
      kind: "create",
      cwd: f.root,
      environment: { CODEXHOST_THREAD_ID: "parent" },
    });
    if (!created.ok) throw Error(created.error.message);
    const session = created.value,
      ref = session.initialState.nativeRef;
    if (!ref) throw Error("Missing fixture identity");
    const model = native.catalog.models.at(-1)?.ref;
    if (!model) throw Error("Missing model");
    expect((await session.execute({ type: "model.select", model })).ok).toBe(true);
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        })
      ).ok,
    ).toBe(true);
    await server.close();
    native = new FakeHarnessAdapter(id, undefined, true, true, null, modes);
    const open = vi.spyOn(native, "open").mockImplementation(async (input) => {
      const session = new FakeHarnessSession(
        id,
        native.catalog,
        "model" in input ? input.model : undefined,
        ref,
        { turns: [] },
        true,
        f.root,
        true,
        "thinkingOptionId" in input ? input.thinkingOptionId : undefined,
        null,
        modes,
        "permissionModeId" in input ? input.permissionModeId : undefined,
      );
      native.sessions.push(session);
      return { ok: true, value: session };
    });
    server = await startHarnessBrokerServer({ ...f, adapter: native });
    expect((await session.readSnapshot()).ok).toBe(true);
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("after-restart"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      kind: "resume",
      nativeRef: ref,
      cwd: f.root,
      model,
      permissionModeId: "plan",
      environment: { CODEXHOST_THREAD_ID: "parent" },
    });
  });
  it("rejects a foreign Harness identity first supplied after create and releases its provisional writer", async () => {
    const f = await fixture(),
      native = new FakeHarnessAdapter(id),
      channel = new HarnessOutputChannel<HarnessOutput>();
    const closed = vi.fn(async () => channel.end());
    const normal = await native.open({ kind: "create", cwd: f.root });
    if (!normal.ok) throw Error(normal.error.message);
    const delayed: HarnessSession = {
      ...normal.value,
      harnessId: id,
      capabilities: normal.value.capabilities,
      initialState: {},
      initialUsage: null,
      outputs: channel.outputs,
      execute: normal.value.execute.bind(normal.value),
      readSnapshot: normal.value.readSnapshot.bind(normal.value),
      close: closed,
    };
    vi.spyOn(native, "open").mockResolvedValueOnce({ ok: true, value: delayed });
    const server = await startHarnessBrokerServer({ ...f, adapter: native });
    cleanup.push(() => server.close());
    const client = new BrokeredHarnessAdapter({ harnessId: id, descriptorPath: f.descriptorPath });
    cleanup.push(() => client.close());
    const opened = await client.open({ kind: "create", cwd: f.root });
    if (!opened.ok) throw Error(opened.error.message);
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    channel.emit({
      kind: "event",
      event: {
        type: "session.state.changed",
        state: {
          nativeRef: {
            harnessId: harnessIdSchema.parse("foreign"),
            nativeSessionId: "other",
            formatVersion: 1,
          },
        },
      },
    });
    expect(await iterator.next()).toMatchObject({
      value: { event: { type: "session.faulted", error: { code: "protocolError" } } },
    });
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect((await client.open({ kind: "create", cwd: f.root })).ok).toBe(true);
  });
  it.each(["after-open", "during-open"])(
    "destroys invalid response connections (%s) without transferring their Session metadata",
    async (scenario) => {
      const f = await fixture(),
        native = new FakeHarnessAdapter(id);
      const server = await startHarnessBrokerServer({ ...f, adapter: native });
      cleanup.push(() => server.close());
      let corrupt = scenario === "during-open",
        connections = 0;
      const sockets = new Set<Socket>();
      const proxy = net.createServer((down) => {
        connections++;
        sockets.add(down);
        const up = net.createConnection(f.socketPath);
        sockets.add(up);
        down.on("close", () => up.destroy());
        up.on("close", () => down.destroy());
        down.on("error", () => up.destroy());
        up.on("error", () => down.destroy());
        down.pipe(up);
        consumeBrokerFrames(
          up,
          (raw) => {
            const frame = harnessBrokerServerFrameSchema.parse(raw);
            const response = frame.kind === "response" && frame.sequence > 1;
            if (corrupt && response) {
              corrupt = false;
              down.write(
                JSON.stringify(frame) +
                  "\n" +
                  JSON.stringify({ ...frame, sequence: frame.sequence + 2 }) +
                  "\n",
              );
            } else down.write(JSON.stringify(frame) + "\n");
          },
          () => down.destroy(),
        );
      });
      const socketPath = f.endpoint("proxy");
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(socketPath, resolve);
      });
      if (process.platform !== "win32") await chmod(socketPath, 0o600);
      cleanup.push(async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => proxy.close(() => r()));
      });
      const descriptorPath = path.join(f.root, "proxy.json");
      await writeFile(descriptorPath, JSON.stringify({ ...server.descriptor, socketPath }), {
        mode: 0o600,
      });
      const client = new BrokeredHarnessAdapter({ harnessId: id, descriptorPath });
      cleanup.push(() => client.close());
      const opened = await client.open({ kind: "create", cwd: f.root });
      if (scenario === "during-open") {
        expect(opened.ok).toBe(false);
        expect(connections).toBe(1);
      } else {
        if (!opened.ok) throw Error(opened.error.message);
        const first = native.sessions[0];
        if (!first) throw Error("Missing native Session");
        const closed = vi.spyOn(first, "close");
        corrupt = true;
        await client.inspect();
        await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 1500 });
      }
    },
  );
});
