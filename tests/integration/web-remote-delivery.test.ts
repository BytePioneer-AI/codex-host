import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { it, type TestContext } from "vitest";
import { requestRemoteSession } from "@codexhost/desktop-control";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import { startControllerAttachmentServer } from "../../packages/desktop-control/src/controller-attachment-server.js";
import { remoteConnectionsExpression } from "../../packages/desktop-control/src/remote-connections-control.js";
import type { RemoteSessionTarget } from "../../packages/desktop-control/src/renderer-remote-sessions.js";
import { RemoteSessions, remoteSessionId } from "../../packages/web-server/src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../../packages/web-server/src/transport.ts";

const identity = { hostId: "remote-control:fixture", threadId: "shared-thread" };
const sessionId = remoteSessionId(identity.hostId, identity.threadId);
const content = [{ type: "text", text: "follow up" }];
const legacyHost = "remote-ssh-discovered:legacy";
const applied = { ok: true, value: { accepted: true } };

function nativeManager(legacy = false, external = false) {
  let active = true;
  let lostReply = false;
  let lostStartReply = false;
  let changedTurn = false;
  let activeTurnId = "active-turn";
  let readOnly = false;
  let failHistory = false;
  let failQueueReads = false;
  const header: {
    modelProvider: string;
    cliVersion: string;
    historyMode?: string;
    codexhostSupportsStrictSteer?: true;
  } = {
    modelProvider: external ? "codexhost" : "openai",
    cliVersion: external ? "codexhost" : "0.0.0-test",
    ...(external ? { historyMode: "paginated" } : {}),
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queue: { id: string; clientUserMessageId: unknown; input: unknown }[] = [];
  const turns = () => [
    { id: "old-unfinished", status: "inProgress", items: [] },
    { id: activeTurnId, status: active ? "inProgress" : "interrupted", items: [] },
  ];
  const row = () => ({
    id: identity.threadId,
    cwd: "/remote",
    ...header,
    createdAt: 1,
    updatedAt: 2,
    status: { type: active ? "active" : "idle" },
    ...(readOnly ? { canAcceptDirectInput: false } : {}),
  });
  const manager = {
    async sendRequest(method: string, params: Record<string, unknown>) {
      calls.push({ method, params: structuredClone(params) });
      if (method.startsWith("thread/queue/") && legacy)
        throw Object.assign(new Error(`${method} requires experimentalApi capability`), {
          jsonRpcCode: -32600,
        });
      switch (method) {
        case "thread/list":
          return { data: [row()], nextCursor: null };
        case "thread/read":
          if (params.includeTurns && failHistory) throw new Error("Full history unavailable");
          return { thread: { ...row(), turns: params.includeTurns ? turns() : [] } };
        case "thread/turns/list":
          assert.equal(params.itemsView, "notLoaded");
          return { data: [turns().at(-1)] };
        case "thread/resume":
          assert.equal(params.excludeTurns, true);
          return { thread: row() };
        case "turn/start":
          assert.equal(active, false);
          return { turn: { id: "started" } };
        case "turn/steer":
          if (changedTurn)
            throw external
              ? Object.assign(new Error("External steering target is no longer active"), {
                  jsonRpcCode: -32074,
                })
              : Object.assign(new Error("expected active turn id active-turn but found next"), {
                  jsonRpcCode: -32600,
                });
          if (external) return { turnId: "replacement-turn", delivery: "newTurn" };
          return { turnId: params.expectedTurnId };
        case "thread/queue/list": {
          if (failQueueReads) throw new Error("Queue temporarily unavailable");
          const limit = Number(params.limit);
          return { data: queue.slice(0, limit), nextCursor: queue.length > limit ? "next" : null };
        }
        case "thread/queue/add": {
          const queuedSubmission = {
            id: `queued-${String(params.clientUserMessageId)}`,
            clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          };
          queue.push(queuedSubmission);
          if (lostReply) throw new Error("Remote connection ended after admission");
          return { queuedSubmission };
        }
        case "thread/queue/start":
          assert.equal(active, false);
          assert.equal(params.queuedSubmissionId, queue[0]?.id);
          queue.shift();
          if (lostStartReply)
            throw Object.assign(new Error("Remote queue start reply timed out"), { code: -32093 });
          return { turn: { id: "queued-turn" } };
        case "thread/queue/delete": {
          const index = queue.findIndex((item) => item.id === params.queuedSubmissionId);
          if (index >= 0) queue.splice(index, 1);
          return { deleted: index >= 0 };
        }
        case "codexhost/thread/usage/inspect":
          return { threadId: identity.threadId, usage: {} };
        default:
          throw Object.assign(new Error(`Unsupported ${method}`), { jsonRpcCode: -32601 });
      }
    },
  };
  return {
    manager,
    header,
    queue,
    writes: () =>
      calls.filter(
        ({ method }) =>
          method.startsWith("turn/") || /^thread\/queue\/(add|delete|start)$/u.test(method),
      ),
    idle: () => {
      active = false;
    },
    loseReply: () => {
      lostReply = true;
    },
    loseStartReply: () => {
      lostStartReply = true;
    },
    changeTurn: () => {
      changedTurn = true;
    },
    advanceTurn: () => {
      activeTurnId = "next-turn";
    },
    readOnly: () => {
      readOnly = true;
    },
    failHistory: () => {
      failHistory = true;
    },
    setQueueReadFailure: (failure: boolean) => {
      failQueueReads = failure;
    },
  };
}

async function fixture(
  t: TestContext,
  options: { external?: boolean; legacyController?: "with-status" | "without-status" } = {},
) {
  const native = nativeManager(false, options.external);
  const legacy = nativeManager(true);
  const routes = new Map([
    [identity.hostId, { manager: native.manager }],
    [legacyHost, { manager: legacy.manager }],
  ]);
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: {
      knownHostIds: () => [...routes.keys()],
      forHost: (hostId) => routes.get(hostId) ?? null,
    },
  };
  const portHolder = createServer();
  await new Promise<void>((resolve) => portHolder.listen(0, "127.0.0.1", resolve));
  const address = portHolder.address();
  await new Promise<void>((resolve) => portHolder.close(() => resolve()));
  assert.ok(address && typeof address !== "string");
  const nonce = "1".repeat(32);
  const operations: RemoteSessionOperation[] = [];
  const directory = await mkdtemp(join(tmpdir(), "web-remote-delivery-"));
  const descriptor = join(directory, "desktop-runtime-v1.json");
  t.onTestFinished(async () => {
    await rm(descriptor, { force: true });
    await rmdir(directory);
  });
  const controller = await startControllerAttachmentServer({
    port: address.port,
    nonce,
    attach: async () => undefined,
    remoteConnections: async (request) => {
      if (request.action === "session") {
        operations.push(request.operation);
        if (
          (options.legacyController && ["delivery", "queue"].includes(request.operation.kind)) ||
          (options.legacyController === "without-status" && request.operation.kind === "status")
        )
          return { error: { code: -32096, message: "Desktop Controller rejected the request" } };
      }
      const reply = await runInNewContext(remoteConnectionsExpression(request), {
        window: target,
        crypto: globalThis.crypto,
      });
      if (
        options.legacyController &&
        request.action === "session" &&
        request.operation.kind === "status" &&
        reply.result
      )
        delete reply.result.supportsDelivery;
      return reply;
    },
  });
  t.onTestFinished(() => controller.close());
  await writeFile(
    descriptor,
    JSON.stringify({
      schema_version: 1,
      launcher_pid: process.pid,
      control_port: address.port,
      nonce,
    }),
    { mode: 0o600 },
  );
  const remote = new RemoteSessions(new EventHub("delivery"), (operation) =>
    requestRemoteSession(operation, descriptor),
  );
  t.onTestFinished(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["session/prompt", "session/updateQueue"])
    rpc.register(method, () => assert.fail(`Remote ${method} reached the local session`));
  const streams = new StreamRegistry();
  let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    route = value;
  };
  remote.install(rpc, streams);
  return {
    remote,
    native,
    legacy,
    operations,
    prompt: (
      mode: "queue" | "steer",
      requestId: string,
      id = sessionId,
      expectedTurnId?: string | null,
      sendWhenIdle?: true,
    ) =>
      rpc.dispatch("session/prompt", {
        args: {
          request: { sessionId: id, mode, requestId, content, expectedTurnId, sendWhenIdle },
        },
      }),
    update: (kind: "remove" | "steer", itemId: string) =>
      rpc.dispatch("session/updateQueue", {
        args: { request: { sessionId, itemId, action: { kind } } },
      }),
    follow: async () => {
      assert.ok(route);
      return route(
        "session/follow",
        { request: { address: { sessionId } } },
        {
          id: "follow",
          closed: false,
          push() {},
          end() {},
          fail: (code, message) => assert.fail(`${code}: ${message}`),
          onClose: (close) => t.onTestFinished(close),
        },
        async () => assert.fail("Remote follow reached the local session"),
      );
    },
  };
}

function errorCode(result: Awaited<ReturnType<RpcRegistry["dispatch"]>>): string {
  assert.ok(!result.ok, JSON.stringify(result));
  return result.error.code;
}

async function observeProjection(
  view: Awaited<ReturnType<RemoteSessions["read"]>>,
  name: string,
  value: unknown,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (JSON.stringify(view.log.projections[name]) === JSON.stringify(value)) break;
    await delay(10);
  }
  assert.deepEqual(view.log.projections[name], value);
}

it("routes a busy Web follow-up to the owning remote queue with the browser receipt ID", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.prompt("queue", "follow-up-receipt"), applied);
  assert.deepEqual(f.native.writes(), [
    {
      method: "thread/queue/add",
      params: {
        threadId: identity.threadId,
        clientUserMessageId: "follow-up-receipt",
        input: [{ ...content[0], text_elements: [] }],
      },
    },
  ]);
  assert.deepEqual(f.legacy.writes(), []);

  const view = await f.remote.read(sessionId);
  const inbox = {
    "next-turn": [
      {
        id: "queued-follow-up-receipt",
        role: "user",
        content,
        source: { kind: "user", rpcId: "follow-up-receipt" },
      },
    ],
    "next-step": [],
  };
  await observeProjection(view, "inbox", inbox);
  assert.equal(
    errorCode(await f.update("steer", "queued-follow-up-receipt")),
    "session/steer-unavailable",
  );
  assert.deepEqual(await f.update("remove", "queued-follow-up-receipt"), applied);
  assert.equal(
    errorCode(await f.update("remove", "queued-follow-up-receipt")),
    "session/queue-item-not-found",
  );
  assert.deepEqual(f.native.queue, []);
});

it("targets the current Turn independently of full history and never redirects a rejected steer", async (t) => {
  const f = await fixture(t);
  f.native.failHistory();
  assert.deepEqual(await f.prompt("steer", "steer-receipt"), applied);
  assert.deepEqual(f.native.writes(), [
    {
      method: "turn/steer",
      params: {
        threadId: identity.threadId,
        expectedTurnId: "active-turn",
        clientUserMessageId: "steer-receipt",
        input: [{ ...content[0], text_elements: [] }],
      },
    },
  ]);
  f.native.changeTurn();
  assert.equal(errorCode(await f.prompt("steer", "stale-turn")), "remote/turn-changed");
  f.native.idle();
  assert.equal(errorCode(await f.prompt("steer", "ended-turn")), "remote/turn-changed");
  assert.deepEqual(
    f.native.writes().map(({ method }) => method),
    ["turn/steer", "turn/steer"],
  );
});

it("rejects a Web steer if its displayed Turn changed before the status read", async (t) => {
  const f = await fixture(t);
  const view = await f.remote.read(sessionId);
  assert.equal(view.log.projections.codexhostActiveTurnId, "active-turn");
  f.native.advanceTurn();
  assert.equal(
    errorCode(await f.prompt("steer", "late-steer", sessionId, "active-turn")),
    "remote/turn-changed",
  );
  assert.deepEqual(f.native.writes(), []);
});

it("steers an external Thread only when the owning Host advertises strict Turn targets", async (t) => {
  const f = await fixture(t, { external: true });
  assert.equal(errorCode(await f.prompt("steer", "legacy-steer")), "remote/steer-unavailable");
  assert.deepEqual(f.native.writes(), []);

  f.native.header.codexhostSupportsStrictSteer = true;
  assert.deepEqual(await f.prompt("steer", "strict-steer"), applied);
  f.native.changeTurn();
  assert.equal(errorCode(await f.prompt("steer", "lost-turn")), "remote/turn-changed");
  assert.deepEqual(
    f.native
      .writes()
      .map(({ method, params }) => [
        method,
        params.expectedTurnId,
        params.codexhostSteerStrictTarget,
      ]),
    [
      ["turn/steer", "active-turn", true],
      ["turn/steer", "active-turn", true],
    ],
  );
});

it("begins only the newly admitted idle item and does not skip existing queued input", async (t) => {
  const f = await fixture(t);
  f.native.idle();
  assert.deepEqual(await f.prompt("queue", "empty-queue"), applied);
  assert.deepEqual(
    f.native.writes().map(({ method }) => method),
    ["thread/queue/add", "thread/queue/start"],
  );
  f.native.queue.push({ id: "older-item", clientUserMessageId: "older-request", input: content });
  assert.deepEqual(await f.prompt("queue", "behind-older-item"), applied);
  assert.deepEqual(
    f.native.queue.map((item) => item.id),
    ["older-item", "queued-behind-older-item"],
  );
  assert.deepEqual(await f.update("steer", "older-item"), applied);
  assert.deepEqual(
    f.native.queue.map((item) => item.id),
    ["queued-behind-older-item"],
  );
});

it("uses native steering and idle queue start for a paginated Codex Thread", async (t) => {
  const f = await fixture(t);
  f.native.header.historyMode = "paginated";
  f.native.header.modelProvider = "codexhost";
  assert.deepEqual(await f.prompt("steer", "native-steer"), applied);
  f.native.idle();
  assert.deepEqual(await f.prompt("queue", "native-idle"), applied);
  assert.deepEqual(f.native.writes(), [
    {
      method: "turn/steer",
      params: {
        threadId: identity.threadId,
        expectedTurnId: "active-turn",
        clientUserMessageId: "native-steer",
        input: [{ ...content[0], text_elements: [] }],
      },
    },
    {
      method: "thread/queue/add",
      params: {
        threadId: identity.threadId,
        clientUserMessageId: "native-idle",
        input: [{ ...content[0], text_elements: [] }],
      },
    },
    {
      method: "thread/queue/start",
      params: { threadId: identity.threadId, queuedSubmissionId: "queued-native-idle" },
    },
  ]);
});

it("lets the owning external Host guard an idle automatic start without a second write", async (t) => {
  const f = await fixture(t, { external: true });
  delete f.native.header.historyMode;
  f.native.idle();
  assert.deepEqual(await f.prompt("queue", "external-idle"), applied);
  assert.deepEqual(f.native.writes(), [
    {
      method: "thread/queue/add",
      params: {
        threadId: identity.threadId,
        clientUserMessageId: "external-idle",
        input: [{ ...content[0], text_elements: [] }],
        codexhostQueueStartIfEmpty: true,
      },
    },
  ]);
  assert.deepEqual(
    f.native.queue.map((item) => item.id),
    ["queued-external-idle"],
  );
});

it("retains ordinary idle sends through a remote Host that rejects the native queue capability", async (t) => {
  const f = await fixture(t);
  const id = remoteSessionId(legacyHost, identity.threadId);
  f.legacy.idle();
  assert.deepEqual(await f.prompt("queue", "legacy-send", id, undefined, true), applied);
  assert.deepEqual(
    f.legacy.writes().map(({ method, params }) => [method, params.clientUserMessageId]),
    [["turn/start", "legacy-send"]],
  );
  assert.equal(
    errorCode(await f.prompt("queue", "explicit-queue", id)),
    "remote/queue-unavailable",
  );
});

it("sends ordinary idle inputs through a Controller that predates delivery", async (t) => {
  const f = await fixture(t, { legacyController: "with-status" });
  assert.equal(errorCode(await f.prompt("queue", "legacy-busy")), "remote/queue-unavailable");
  assert.equal(errorCode(await f.prompt("steer", "legacy-steer")), "remote/steer-unavailable");
  f.native.idle();
  assert.deepEqual(await f.prompt("queue", "legacy-idle", sessionId, undefined, true), applied);
  assert.deepEqual(
    f.native.writes().map(({ method, params }) => [method, params.clientUserMessageId]),
    [["turn/start", "legacy-idle"]],
  );
  assert.equal(
    f.operations.some((operation) => operation.kind === "delivery"),
    false,
  );
});

it("uses the existing authenticated read when an older Controller also lacks lightweight status", async (t) => {
  const f = await fixture(t, { legacyController: "without-status" });
  f.native.idle();
  assert.deepEqual(await f.prompt("queue", "legacy-send", sessionId, undefined, true), applied);
  assert.deepEqual(
    f.native.writes().map(({ method, params }) => [method, params.clientUserMessageId]),
    [["turn/start", "legacy-send"]],
  );
  assert.equal(
    f.operations.some((operation) => operation.kind === "delivery"),
    false,
  );
});

it("keeps a confirmed queue admission when the separate native start reply is lost", async (t) => {
  const f = await fixture(t);
  f.native.idle();
  f.native.loseStartReply();
  assert.deepEqual(await f.prompt("queue", "admitted", sessionId, undefined, true), {
    ok: true,
    value: { accepted: true, queueStartUnconfirmed: true },
  });
  assert.deepEqual(
    f.operations.flatMap((operation) =>
      operation.kind === "delivery" ? [operation.action.kind] : [],
    ),
    ["enqueue", "start"],
  );
  assert.deepEqual(
    f.native.writes().map(({ method }) => method),
    ["thread/queue/add", "thread/queue/start"],
  );
});

it("refreshes the other client's queue changes while the transcript remains unavailable", async (t) => {
  const f = await fixture(t);
  const view = await f.remote.read(sessionId);
  await observeProjection(view, "queueState", { previewOnly: true });
  assert.equal(await f.follow(), true);
  f.native.failHistory();
  f.native.setQueueReadFailure(true);
  await observeProjection(view, "queueState", { previewOnly: true, stale: true }, 400);

  f.native.queue.push({ id: "from-desktop", clientUserMessageId: "desktop-id", input: content });
  f.native.setQueueReadFailure(false);
  await observeProjection(
    view,
    "inbox",
    {
      "next-turn": [
        {
          id: "from-desktop",
          role: "user",
          content,
          source: { kind: "user", rpcId: "desktop-id" },
        },
      ],
      "next-step": [],
    },
    400,
  );
  assert.deepEqual(view.log.projections.queueState, { previewOnly: true });
  assert.ok(view.log.projections.remoteHistoryError);
});

it("rejects explicit queue on an old Host and never replays an unknown queue outcome", async (t) => {
  const f = await fixture(t);
  const id = remoteSessionId(legacyHost, identity.threadId);
  assert.equal(errorCode(await f.prompt("queue", "legacy-active", id)), "remote/queue-unavailable");
  f.legacy.idle();
  assert.equal(errorCode(await f.prompt("queue", "legacy-idle", id)), "remote/queue-unavailable");
  assert.deepEqual(
    f.legacy.writes().map(({ method, params }) => [method, params.clientUserMessageId]),
    [["thread/queue/add", "legacy-active"]],
  );

  const view = await f.remote.read(sessionId);
  await observeProjection(view, "queueState", { previewOnly: true });
  f.native.idle();
  f.native.failHistory();
  f.native.loseReply();
  assert.equal(
    errorCode(await f.prompt("queue", "lost-receipt", sessionId, undefined, true)),
    "remote/outcome-unknown",
  );
  assert.deepEqual(
    f.native.writes().map(({ method }) => method),
    ["thread/queue/add"],
  );
  await observeProjection(view, "inbox", {
    "next-turn": [
      {
        id: "queued-lost-receipt",
        role: "user",
        content,
        source: { kind: "user", rpcId: "lost-receipt" },
      },
    ],
    "next-step": [],
  });
  f.native.readOnly();
  assert.equal(errorCode(await f.prompt("queue", "readonly")), "remote/send-rejected");
  assert.deepEqual(
    f.native.writes().map(({ method }) => method),
    ["thread/queue/add"],
  );
});
