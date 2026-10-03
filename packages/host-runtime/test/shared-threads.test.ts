import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import {
  SharedThreadBridge,
  connectSharedThreads,
  sharedThreadSocketPath,
} from "../src/shared-thread-bridge.js";
import {
  createRemoteAppServerWebSocketListener,
  prepareRemoteAppServerSocketDirectory,
} from "../src/remote-app-server.js";
import {
  createFixture,
  JsonLineCollector,
  startPiThread,
  startPiTurn,
  writeRequest,
} from "./app-server-host-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function session(adapter: FakeHarnessAdapter) {
  const value = adapter.sessions[0];
  if (!value) throw new Error("Expected one running Harness Session");
  return value;
}

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-threads-"));
  const owner = new SharedThreadOwner();
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const open = vi.spyOn(adapter, "open");
  const diagnosticOutput = new PassThrough();
  const store = new MappingStore({ directory });
  const host = new AppServerHost({
    stockCodexPath: "/unused",
    arguments: [],
    defaultAgent: "codex",
    externalOnly: true,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    diagnosticOutput,
    mappingStore: store,
    externalAdapters: new Map([["pi", adapter]]),
  });
  const running = host.run();
  cleanup.push(async () => {
    host.close();
    await running;
    owner.close();
    owner.output.end();
    rmSync(directory, { recursive: true, force: true });
  });
  function front(delegateCreates: boolean, connect = async () => owner.connect()) {
    const bridge = new SharedThreadBridge({ connect, delegateCreates, diagnose: () => undefined });
    const fixture = createFixture({ sharedThreads: bridge });
    const official = new JsonLineCollector(fixture.official.stdin);
    fixture.official.stdin.on("data", () => {
      for (const request of official.messages.splice(0)) {
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: { data: [], nextCursor: null, backwardsCursor: null },
          })}\n`,
        );
      }
    });
    cleanup.push(async () => {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    });
    return fixture;
  }
  return { owner, adapter, open, front, host, directory, diagnosticOutput };
}

async function rpc(
  front: ReturnType<typeof createFixture>,
  id: number,
  method: string,
  params: JsonObject,
) {
  writeRequest(front.desktopInput, { id, method, params });
  return front.collector.waitFor((message) => message.id === id);
}

describe("shared external Threads", () => {
  it("steers from the other GUI through the same cancellation and replacement sequence", async () => {
    const { front, adapter, open } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    const turnId = await startPiTurn(ssh, threadId);
    session(adapter).completeCancellationOnRequest();
    const result = await rpc(desktop, 30, "turn/steer", {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId: "from-other-viewer",
      input: [{ type: "text", text: "change direction" }],
    });
    expect(result).not.toHaveProperty("error");
    for (const viewer of [ssh, desktop]) {
      const next = await viewer.collector.waitFor(
        (m) =>
          m.method === "turn/started" &&
          ((m.params as JsonObject).turn as JsonObject).id !== turnId,
      );
      expect(next).toMatchObject({
        params: { turn: { items: [{ type: "userMessage", clientId: "from-other-viewer" }] } },
      });
    }
    expect(open).toHaveBeenCalledOnce();
    session(adapter).succeedTurn();
  });

  it("shows one approval on both GUIs and accepts only one answer", async () => {
    const { front, adapter } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    session(adapter).requestApprovalOnNextTurn("Allow shared action?");
    await startPiTurn(ssh, threadId);
    const a = await ssh.collector.waitFor((m) => m.method === "mcpServer/elicitation/request");
    const b = await desktop.collector.waitFor((m) => m.method === "mcpServer/elicitation/request");
    expect(a).toEqual(b);
    expect(String(a.id)).toMatch(/^shared-interaction:/);
    const late = front(false);
    const c = await late.collector.waitFor((m) => m.method === "mcpServer/elicitation/request");
    expect(c).toEqual(a);
    writeRequest(desktop.desktopInput, {
      id: String(b.id),
      result: { action: "accept", content: {}, _meta: null },
    });
    writeRequest(ssh.desktopInput, {
      id: String(a.id),
      result: { action: "accept", content: {}, _meta: null },
    });
    await vi.waitFor(() => expect(session(adapter).interactionResponses).toHaveLength(1));
    for (const viewer of [ssh, desktop, late]) {
      expect(
        await viewer.collector.waitFor((m) => m.method === "serverRequest/resolved"),
      ).toMatchObject({ params: { requestId: a.id, threadId } });
    }
    session(adapter).succeedTurn();
  });

  it("fails a disconnected shared operation without falling back to another Session", async () => {
    const { front, owner, adapter } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    await rpc(desktop, 10, "codexhost/thread/ownership/list", { threadIds: [threadId] });
    owner.close();
    const result = await rpc(desktop, 20, "turn/start", {
      threadId,
      input: [{ type: "text", text: "do not duplicate" }],
    });
    expect(result).toHaveProperty("error");
    expect(desktop.adapter.sessions).toHaveLength(0);
    expect(adapter.sessions).toHaveLength(1);
    writeRequest(desktop.desktopInput, {
      id: "shared-interaction:expired:1",
      result: { action: "accept", content: {}, _meta: null },
    });
    expect(await rpc(desktop, 21, "model/list", {})).toHaveProperty("result");
  });

  it("broadcasts rename and archive changes and filters subsequent lists", async () => {
    const { front } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    expect(
      await rpc(desktop, 20, "thread/name/set", { threadId, name: "shared title" }),
    ).not.toHaveProperty("error");
    expect(await rpc(ssh, 21, "thread/list", {})).toMatchObject({
      result: { data: [{ id: threadId, name: "shared title" }] },
    });
    expect(await rpc(desktop, 22, "thread/archive", { threadId })).not.toHaveProperty("error");
    await ssh.collector.waitFor((m) => m.method === "thread/archived");
    expect(await rpc(ssh, 23, "thread/list", {})).toMatchObject({ result: { data: [] } });
    expect(await rpc(desktop, 24, "thread/list", { archived: true })).toMatchObject({
      result: { data: [{ id: threadId }] },
    });
  });

  it("renders the same accepted user message and streamed reply in both GUIs with one Session", async () => {
    const { front, adapter, open } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    await desktop.collector.waitFor(
      (m) => m.method === "thread/started" && (m.params as JsonObject).thread !== undefined,
    );
    const accepted = await rpc(ssh, 20, "turn/start", {
      threadId,
      clientUserMessageId: "message-a",
      input: [{ type: "text", text: "hello from SSH" }],
    });
    expect(accepted).not.toHaveProperty("error");
    const ownStart = await ssh.collector.waitFor((m) => m.method === "turn/started");
    expect(ssh.collector.messages.indexOf(accepted)).toBeLessThan(
      ssh.collector.messages.indexOf(ownStart),
    );
    for (const viewer of [ssh, desktop]) {
      const start = await viewer.collector.waitFor((m) => m.method === "turn/started");
      expect(start).toMatchObject({
        params: {
          threadId,
          turn: {
            items: [
              { type: "userMessage", clientId: "message-a", content: [{ text: "hello from SSH" }] },
            ],
          },
        },
      });
    }
    session(adapter).appendText("same reply");
    for (const viewer of [ssh, desktop]) {
      await expect(
        viewer.collector.waitFor((m) => m.method === "item/agentMessage/delta"),
      ).resolves.toMatchObject({ params: { threadId, delta: "same reply" } });
    }
    expect(desktop.collector.messages.some((m) => m.id === 20)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(ssh.adapter.sessions).toHaveLength(0);
    expect(desktop.adapter.sessions).toHaveLength(0);
    session(adapter).succeedTurn();
    await desktop.collector.waitFor((m) => m.method === "turn/completed");
  });

  it("allows the other GUI to interrupt and then send; concurrent sends execute only once", async () => {
    const { front, adapter, open } = setup();
    const ssh = front(true);
    const desktop = front(false);
    const threadId = await startPiThread(ssh);
    const turnId = await startPiTurn(ssh, threadId);
    session(adapter).completeCancellationOnRequest();
    await expect(
      rpc(desktop, 20, "turn/interrupt", { threadId, turnId }),
    ).resolves.not.toHaveProperty("error");
    await ssh.collector.waitFor((m) => m.method === "turn/completed");
    await desktop.collector.waitFor((m) => m.method === "turn/completed");
    const sends = await Promise.all([
      rpc(ssh, 30, "turn/start", { threadId, input: [{ type: "text", text: "A" }] }),
      rpc(desktop, 30, "turn/start", { threadId, input: [{ type: "text", text: "B" }] }),
    ]);
    expect(sends.filter((r) => r.result)).toHaveLength(1);
    expect(sends.filter((r) => r.error)).toMatchObject([{ error: { code: -32072 } }]);
    session(adapter).succeedTurn();
    await vi.waitFor(() =>
      expect(desktop.collector.messages.filter((m) => m.method === "turn/completed")).toHaveLength(
        2,
      ),
    );
    const next = await rpc(desktop, 40, "turn/start", {
      threadId,
      input: [{ type: "text", text: "from desktop" }],
    });
    expect(next).not.toHaveProperty("error");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("deduplicates accepted message IDs across clients without replaying a Turn", async () => {
    const { owner, front, adapter } = setup();
    const ssh = front(true);
    const threadId = await startPiThread(ssh);
    const a = owner.connect();
    const b = owner.connect();
    const params = {
      threadId,
      clientUserMessageId: "same",
      input: [{ type: "text", text: "once" }],
    };
    const [one, two] = await Promise.all([
      a.request("turn/start", params),
      b.request("turn/start", params),
    ]);
    expect(one.result).toEqual(two.result);
    expect(one).not.toHaveProperty("error");
    session(adapter).succeedTurn();
    await ssh.collector.waitFor((m) => m.method === "turn/completed");
    expect((await b.request("turn/start", params)).result).toEqual(one.result);
    expect(
      await b.request("turn/start", { ...params, input: [{ type: "text", text: "different" }] }),
    ).toMatchObject({ error: { code: -32602 } });
    a.close();
    b.close();
  });

  it("keeps an active Session alive after a viewer disconnects and resumes its accumulated output", async () => {
    const { front, adapter, open } = setup();
    const ssh = front(true);
    const threadId = await startPiThread(ssh);
    await startPiTurn(ssh, threadId);
    session(adapter).appendText("before disconnect");
    ssh.host.disconnect();
    await ssh.running;
    session(adapter).appendText(" after disconnect");
    const desktop = front(false);
    await desktop.ready;
    const resume = await rpc(desktop, 20, "thread/resume", { threadId });
    expect(resume).not.toHaveProperty("error");
    expect(JSON.stringify(resume.result)).toContain("before disconnect after disconnect");
    expect(open).toHaveBeenCalledTimes(1);
    session(adapter).succeedTurn();
    await desktop.collector.waitFor((m) => m.method === "turn/completed");
  });

  it("merges shared Threads into the local list without importing them or changing native routing", async () => {
    const { front } = setup();
    const ssh = front(true);
    const threadId = await startPiThread(ssh);
    const desktop = front(false);
    await desktop.ready;
    expect(await rpc(desktop, 20, "thread/list", { cwd: ["/synthetic"] })).toMatchObject({
      result: { data: [{ id: threadId }] },
    });
    expect(await rpc(desktop, 21, "thread/list", { cwd: ["/other"] })).toMatchObject({
      result: { data: [] },
    });
    expect(
      await rpc(desktop, 22, "codexhost/thread/ownership/list", { threadIds: [threadId] }),
    ).toMatchObject({ result: { threads: [{ threadId, owner: "external", harnessId: "pi" }] } });
    expect(await desktop.mappingStore.listThreads()).toEqual([]);
    expect(await rpc(desktop, 23, "model/list", {})).toHaveProperty("result");
  });

  it.skipIf(process.platform === "win32")(
    "shares the same execution through the private Unix socket",
    async () => {
      const { owner, front, adapter, directory } = setup();
      // Unix socket paths are bounded; use a short real directory, not the macOS temp prefix.
      const environment = { CODEX_HOME: path.join("/tmp", path.basename(directory)) };
      const socketPath = sharedThreadSocketPath(environment);
      await prepareRemoteAppServerSocketDirectory(socketPath);
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: (streams) => owner.createSession(streams),
      });
      await listener.listen();
      cleanup.push(async () => {
        await listener.close();
        rmSync(environment.CODEX_HOME, { recursive: true, force: true });
      });
      const ssh = front(true);
      const threadId = await startPiThread(ssh);
      const peer = await connectSharedThreads(environment);
      expect(peer).not.toBeNull();
      if (!peer) throw new Error("Shared Thread socket did not connect");
      const events: JsonObject[] = [];
      peer.subscribe((m) => events.push(m));
      const accepted = await peer.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "via socket" }],
      });
      expect(accepted).not.toHaveProperty("error");
      session(adapter).appendText("socket output");
      await vi.waitFor(() =>
        expect(events.some((m) => m.method === "item/agentMessage/delta")).toBe(true),
      );
      peer.close();
      session(adapter).succeedTurn();
      await ssh.collector.waitFor((m) => m.method === "turn/completed");
    },
  );
});
