import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as c from "@codexhost/shared-contracts";
import { ChFileInputs } from "../src/ch-file-inputs.ts";
import { serveFileUpload } from "../src/ch-file-upload-http.ts";
import type { ChThread } from "../src/ch-thread-view.ts";
import { servePeerAttachments } from "../src/peer-attachments-http.ts";
import { PeerHostManager, createCompositeRemoteCall } from "../src/peer-host-manager.ts";
import { PeerHostStore } from "../src/peer-host-store.ts";
import { peerEndpoint } from "../src/peer-manifest.ts";
import { RemotePeerAttachments } from "../src/remote-peer-attachments.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { WebFiles } from "../src/web-files.ts";
import { WebImages, WEB_IMAGE_LIMITS } from "../src/web-images.ts";
import { Workspaces } from "../src/workspaces.ts";
import { defined } from "./support/defined.ts";
import { PNG } from "./support/image.ts";

const PNG_BYTES = Buffer.from(PNG, "base64");

interface MockPeerHarnessOptions {
  token: string;
  attachmentsEnabled: boolean;
  workspaceDir: string;
  dataDir: string;
  initialThreads: ChThread[];
  failNextPrompt?: () => boolean;
}

async function startRealPeerServer(options: MockPeerHarnessOptions) {
  const data = new DataDir(options.dataDir);
  const images = new WebImages(data);
  const files = new WebFiles(data, images);
  const workspaces = new Workspaces(data, options.workspaceDir, true);
  workspaces.create(options.workspaceDir);
  const peerRpc = new RpcRegistry();
  workspaces.register(peerRpc, new StreamRegistry());
  const threads = new Map<string, ChThread>(
    options.initialThreads.map((thread) => [thread.id, thread]),
  );
  let nextThreadSeq = 1;
  let nextTurnSeq = 10;
  const epoch = randomUUID();
  const promptHistory: Array<{
    sessionId: string;
    mode?: string;
    content: unknown[];
    preparedInput: unknown[];
    scopeBound: boolean;
  }> = [];

  const fileInputs = new ChFileInputs(files, images, async (id) => {
    if (!threads.has(id)) throw new RpcError("session/not-found", "Thread not found.");
    return id;
  });

  peerRpc.register("session/prompt", async (args) => {
    const req = (
      args as {
        request: {
          sessionId: string;
          mode?: string;
          requestId?: string;
          expectedTurnId?: string | null;
          content: unknown[];
        };
      }
    ).request;
    if (options.failNextPrompt?.()) {
      throw new RpcError("remote/transient-error", "Temporary peer prompt failure");
    }
    const thread = threads.get(req.sessionId);
    if (!thread) throw new RpcError("session/not-found", "Thread not found.");
    const prepared = await fileInputs.prepare(req.sessionId, req.content);
    fileInputs.accepted(req.sessionId, req.content);
    const turnId = `turn-${++nextTurnSeq}`;
    thread.turns.push({
      id: turnId,
      status: "completed",
      items: [
        {
          id: `user-${turnId}`,
          type: "userMessage",
          content: prepared.input,
        },
        {
          id: `assistant-${turnId}`,
          type: "agentMessage",
          text: "Received your attachment.",
        },
      ],
    });
    thread.updatedAt += 10;
    promptHistory.push({
      sessionId: req.sessionId,
      ...(req.mode !== undefined ? { mode: req.mode } : {}),
      content: req.content,
      preparedInput: prepared.input,
      scopeBound: true,
    });
    return { accepted: true };
  });

  const peerSessions = {
    uploadFile: (
      id: string,
      chunks: AsyncIterable<Uint8Array>,
      name?: string,
      imageMediaType?: string,
    ) => fileInputs.upload(id, chunks, name, imageMediaType),
    localWorkspaceRoot: (id: string) => (threads.has(id) ? options.workspaceDir : undefined),
  };

  const eventResponses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if (pathname.startsWith("/api/peer/v1/")) {
        const route = pathname.slice("/api/peer/v1/".length);
        if (route === "uploads" || route === "prompt" || route === "file") {
          if (!options.attachmentsEnabled) {
            res
              .writeHead(404, { "content-type": "application/json" })
              .end(JSON.stringify({ error: "Peer attachments unavailable" }));
            return;
          }
          await servePeerAttachments(req, res, route, {
            sessions: peerSessions,
            files,
            images,
            rpc: peerRpc,
          });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const result = await peerEndpoint(
          req.method ?? "GET",
          url,
          body,
          workspaces,
          peerRpc,
          epoch,
          "1.2.3",
          [options.workspaceDir],
          { attachments: options.attachmentsEnabled },
        );
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (pathname === "/api/ch/v1/events") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({
            type: "hello",
            version: 1,
            cursor: { epoch, sequence: 1 },
            reset: false,
          })}\n`,
        );
        eventResponses.add(res);
        req.on("close", () => eventResponses.delete(res));
        return;
      }
      if (pathname === "/api/ch/v1/snapshot") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { threadId: string };
        const thread = threads.get(body.threadId);
        if (!thread) {
          res
            .writeHead(404, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { code: -32004, message: "Thread not found" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            result: {
              thread: { ...thread, turns: [] },
              turnsPage: {
                data: thread.turns,
                nextCursor: null,
              },
              cursor: { epoch, sequence: 1 },
              activeTurnId: null,
              configuration: { owner: "codex", locked: true, native: {} },
              queue: { available: true, pausedReason: null, items: [] },
              interactions: [],
            },
          }),
        );
        return;
      }
      if (pathname === "/api/ch/v1/rpc") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          method: string;
          params: Record<string, unknown>;
        };
        const sendResult = (result: unknown) => {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ result }));
        };
        switch (body.method) {
          case "codexhost/thread/catalog/read": {
            const list = [...threads.values()];
            sendResult({
              threads: list.map((t) => ({ ...t, turns: [] })),
              ownership: list.map((t) => ({
                threadId: t.id,
                owner: "codex",
              })),
              archivedThreadIds: [],
              nextCursor: null,
              hasMore: false,
            });
            return;
          }
          case "codexhost/thread/tree/read":
            sendResult({ edges: [] });
            return;
          case "codexhost/harness/plugins/list":
            sendResult({ plugins: [] });
            return;
          case "codexhost/harness/list":
            sendResult({ harnesses: [] });
            return;
          case "codexhost/harness/inspect":
            sendResult({
              status: "ready",
              capabilities: {
                configuration: {
                  selectModel: true,
                  selectThinkingOption: true,
                  selectPermissionMode: false,
                  permissionModeScope: "live",
                },
                history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
              },
              catalog: {
                defaultModel: { id: "gpt-5" },
                models: [
                  { ref: { id: "gpt-5" }, label: "GPT-5", supportedThinkingOptionIds: ["medium"] },
                ],
                thinkingOptions: [{ id: "medium", label: "Medium" }],
                defaultThinkingOptionId: "medium",
              },
            });
            return;
          case "codexhost/thread/inspect":
            sendResult({
              owner: "codex",
              locked: true,
              effectiveModel: { id: "gpt-5" },
            });
            return;
          case "codexhost/thread/usage/inspect":
            sendResult({
              threadId: String(body.params.threadId ?? ""),
              usage: {},
            });
            return;
          case "thread/turns/list": {
            const thread = threads.get(String(body.params.threadId ?? ""));
            sendResult({
              data: thread ? thread.turns : [],
              nextCursor: null,
            });
            return;
          }
          case "thread/start": {
            const newId = `peer-thread-${++nextThreadSeq}`;
            const created: ChThread = {
              id: newId,
              cwd: String(body.params.cwd ?? options.workspaceDir),
              name: `Created ${newId}`,
              modelProvider: "openai",
              createdAt: 2000,
              updatedAt: 2000,
              status: { type: "idle" },
              turns: [],
            };
            threads.set(newId, created);
            sendResult({ thread: created });
            return;
          }
          case "turn/start": {
            const tid = String(body.params.threadId ?? "");
            const thread = threads.get(tid);
            if (!thread) {
              res.writeHead(404).end();
              return;
            }
            const turnId = `turn-${++nextTurnSeq}`;
            thread.turns.push({
              id: turnId,
              status: "completed",
              items: [
                {
                  id: `u-${turnId}`,
                  type: "userMessage",
                  content: Array.isArray(body.params.input) ? body.params.input : [],
                },
              ],
            });
            sendResult({ turn: { id: turnId } });
            return;
          }
          default:
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                error: { code: -32601, message: `Unknown method ${body.method}` },
              }),
            );
            return;
        }
      }
      res.writeHead(404).end();
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    threads,
    promptHistory,
    close: async () => {
      for (const res of eventResponses) res.destroy();
      eventResponses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startHubHttpServer(remoteSessions: RemoteSessions) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/session/uploadFileBinary" && req.method === "POST") {
      void serveFileUpload(undefined, req, res, false, remoteSessions);
      return;
    }
    if (
      pathname === c.REMOTE_PEER_FILE_PROXY_PATH &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      void remoteSessions.servePeerFile(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForConnected(
  manager: PeerHostManager,
  hostIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (hostIds.every((hostId) => manager.client(hostId)?.state === "connected")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for peers to connect");
}

it("executes end-to-end Peer attachment upload, prompt, draft retry, preview, legacy gating, desktop rejection, and encoded-image rejection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-attach-flow-"));
  const outside = mkdtempSync(join(tmpdir(), "remote-peer-attach-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const peerWorkspace = join(root, "peer-workspace");
  mkdirSync(join(peerWorkspace, "sub"), { recursive: true });
  writeFileSync(join(peerWorkspace, "sub", "screenshot.png"), PNG_BYTES);
  writeFileSync(join(outside, "secret.png"), PNG_BYTES);

  const legacyWorkspace = join(root, "legacy-workspace");
  mkdirSync(legacyWorkspace, { recursive: true });

  let failNextPromptCount = 0;
  const modernPeer = await startRealPeerServer({
    token: "modern-token",
    attachmentsEnabled: true,
    workspaceDir: peerWorkspace,
    dataDir: join(root, "modern-data"),
    failNextPrompt: () => {
      if (failNextPromptCount > 0) {
        failNextPromptCount--;
        return true;
      }
      return false;
    },
    initialThreads: [
      {
        id: "existing-1",
        cwd: peerWorkspace,
        name: "Existing Peer Thread",
        modelProvider: "openai",
        createdAt: 1000,
        updatedAt: 1000,
        status: { type: "idle" },
        turns: [],
      },
    ],
  });
  t.after(() => modernPeer.close());

  const legacyPeer = await startRealPeerServer({
    token: "legacy-token",
    attachmentsEnabled: false,
    workspaceDir: legacyWorkspace,
    dataDir: join(root, "legacy-data"),
    initialThreads: [
      {
        id: "legacy-1",
        cwd: legacyWorkspace,
        name: "Legacy Peer Thread",
        modelProvider: "openai",
        createdAt: 1000,
        updatedAt: 1000,
        status: { type: "idle" },
        turns: [],
      },
    ],
  });
  t.after(() => legacyPeer.close());

  const hubData = new DataDir(join(root, "hub-data"));
  const hubEvents = new EventHub(root);
  const peerStore = new PeerHostStore(hubData);
  const now = new Date().toISOString();
  peerStore.save([
    {
      peerId: "modern",
      name: "Modern Peer",
      origin: modernPeer.origin,
      token: "modern-token",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      peerId: "legacy",
      name: "Legacy Peer",
      origin: legacyPeer.origin,
      token: "legacy-token",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const peerAttachments = new RemotePeerAttachments({ requestTimeoutMs: 5_000 });
  const peerManager = new PeerHostManager(peerStore, async () => [], hubEvents, {
    allowLoopback: true,
    projector: (threadId) => peerAttachments.projector(threadId),
  });
  t.after(() => peerManager.close());

  const modernHostId = c.remotePeerHostId("modern");
  const legacyHostId = c.remotePeerHostId("legacy");
  const desktopHostId = "remote-control:desktop-1";
  await waitForConnected(peerManager, [modernHostId, legacyHostId]);

  const desktopRow: ChThread = {
    id: "desk-1",
    cwd: "/desktop/repo",
    name: "Desktop Thread",
    modelProvider: "openai",
    createdAt: 1000,
    updatedAt: 1000,
    status: { type: "idle" },
    turns: [],
  };
  const desktopCall = async (op: c.RemoteSessionOperation): Promise<unknown> => {
    if (op.kind === "hosts") {
      return [{ hostId: desktopHostId, online: true, epoch: "desk-epoch", displayName: "Desktop" }];
    }
    if (op.kind === "list") {
      return { data: [desktopRow], nextCursor: null };
    }
    if (op.kind === "read") {
      return { result: { thread: desktopRow }, epoch: "desk-epoch", requests: [] };
    }
    if (op.kind === "queue") return { available: false };
    return {};
  };

  const hubWorkspaces = new Workspaces(hubData, join(root, "hub-ws"), true);
  const remoteSessions = new RemoteSessions(
    hubEvents,
    createCompositeRemoteCall(peerManager, desktopCall),
    hubWorkspaces,
    peerManager,
    peerAttachments,
  );
  t.after(() => remoteSessions.close());

  const hubRpc = new RpcRegistry();
  const hubStreams = new StreamRegistry();
  for (const method of [
    "session/list",
    "session/create",
    "session/prompt",
    "session/attachment",
    "session/projections",
  ]) {
    hubRpc.register(method, () => (method === "session/list" ? { items: [] } : {}));
  }
  remoteSessions.install(hubRpc, hubStreams);

  const hubHttp = await startHubHttpServer(remoteSessions);
  t.after(() => hubHttp.close());

  await remoteSessions.refresh();

  const modernSessionId = remoteSessionId(modernHostId, "existing-1");
  const legacySessionId = remoteSessionId(legacyHostId, "legacy-1");
  const desktopSessionId = remoteSessionId(desktopHostId, "desk-1");

  // Verify capability-gated projections across modern Peer, legacy Peer, and Desktop remote
  const listed = await hubRpc.dispatch("session/list", {});
  assert.ok(listed.ok);
  const listItems = (
    listed.value as {
      items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
    }
  ).items;
  const modernItem = defined(listItems.find((item) => item.sessionId === modernSessionId));
  const legacyItem = defined(listItems.find((item) => item.sessionId === legacySessionId));
  const desktopItem = defined(listItems.find((item) => item.sessionId === desktopSessionId));

  assert.deepEqual(modernItem.projections.values.attachmentInput, { enabled: true });
  assert.deepEqual(modernItem.projections.values.imageLimits, WEB_IMAGE_LIMITS);
  assert.equal(
    (modernItem.projections.values.remoteHost as { filePreview?: boolean }).filePreview,
    true,
  );

  assert.deepEqual(legacyItem.projections.values.attachmentInput, { enabled: false });
  assert.equal(
    (legacyItem.projections.values.remoteHost as { filePreview?: boolean }).filePreview,
    false,
  );

  assert.deepEqual(desktopItem.projections.values.attachmentInput, { enabled: false });
  assert.equal(
    (desktopItem.projections.values.remoteHost as { filePreview?: boolean }).filePreview,
    false,
  );

  // -------------------------------------------------------------------------
  // 1. Existing Peer thread: upload PNG -> submit -> session/attachment -> /api/remote-peer/file
  // -------------------------------------------------------------------------
  const existingUploadRes = await fetch(
    `${hubHttp.origin}/api/session/uploadFileBinary?${new URLSearchParams({
      sessionId: modernSessionId,
      name: "shot.png",
      imageMediaType: "image/png",
    })}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG_BYTES,
    },
  );
  assert.equal(existingUploadRes.status, 200);
  const existingUpload = c.remotePeerUploadResultSchema.parse(await existingUploadRes.json());
  assert.equal(existingUpload.ok, true);

  const existingPromptRes = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: modernSessionId,
        requestId: "req-existing-1",
        mode: "queue",
        sendWhenIdle: true,
        content: [
          { type: "file", receiptId: existingUpload.value.receiptId },
          { type: "text", text: "Please inspect this screenshot" },
        ],
      },
    },
  });
  assert.deepEqual(existingPromptRes, { ok: true, value: { accepted: true } });
  assert.equal(modernPeer.promptHistory.length, 1);

  // Refresh view so placeholder projector runs on the newly recorded user image message
  const view = await remoteSessions.read(modernSessionId, true);
  const userEvent = view.log.events.find((event) => event.type === "user/message");
  const projectedImagePart = (
    userEvent?.data as {
      content?: Array<{ type?: string; attachment?: { attachmentId: string; width: number } }>;
    }
  )?.content?.find((part) => part.type === "image");
  const projectedAttachmentId = defined(projectedImagePart?.attachment?.attachmentId);
  assert.ok(projectedAttachmentId.startsWith("peer-image:"));
  // Placeholder width before readAttachment is 64
  assert.equal(projectedImagePart?.attachment?.width, 64);

  // Read full image via session/attachment RPC (fetches real bytes from Peer)
  const attachmentRes = await hubRpc.dispatch("session/attachment", {
    args: {
      request: {
        sessionId: modernSessionId,
        attachmentId: projectedAttachmentId,
      },
    },
  });
  assert.ok(attachmentRes.ok, JSON.stringify(attachmentRes));
  const attachmentValue = attachmentRes.value as {
    attachment: { attachmentId: string; width: number; height: number; mediaType: string };
    data: string;
  };
  assert.equal(attachmentValue.attachment.attachmentId, projectedAttachmentId);
  assert.equal(attachmentValue.attachment.width, 32);
  assert.equal(attachmentValue.attachment.height, 24);
  assert.equal(attachmentValue.attachment.mediaType, "image/png");
  assert.equal(attachmentValue.data, PNG);

  // Preview workspace image via GET & HEAD /api/remote-peer/file
  const previewGet = await fetch(
    `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
      sessionId: modernSessionId,
      path: "sub/screenshot.png",
    })}`,
  );
  assert.equal(previewGet.status, 200);
  assert.equal(previewGet.headers.get("content-type"), "image/png");
  assert.equal(previewGet.headers.get("cache-control"), "private, no-store");
  assert.equal(previewGet.headers.get("x-content-type-options"), "nosniff");
  assert.equal(previewGet.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.deepEqual(Buffer.from(await previewGet.arrayBuffer()), PNG_BYTES);

  const previewHead = await fetch(
    `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
      sessionId: modernSessionId,
      path: "sub/screenshot.png",
    })}`,
    { method: "HEAD" },
  );
  assert.equal(previewHead.status, 200);
  assert.equal(previewHead.headers.get("content-type"), "image/png");
  assert.equal((await previewHead.arrayBuffer()).byteLength, 0);

  // Outside workspace file and invalid sessionIds are rejected with 404
  const outsidePreview = await fetch(
    `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
      sessionId: modernSessionId,
      path: join(outside, "secret.png"),
    })}`,
  );
  assert.equal(outsidePreview.status, 404);

  for (const badSessionId of [
    "local-thread-1",
    "web-remote:invalid",
    remoteSessionId("remote-peer:unknown", "t1"),
  ]) {
    const res = await fetch(
      `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
        sessionId: badSessionId,
        path: "sub/screenshot.png",
      })}`,
    );
    assert.equal(res.status, 404, `expected 404 for ${badSessionId}`);
  }

  // -------------------------------------------------------------------------
  // 2. Peer draft: upload file -> attachment-only first message succeeds (create + scope bind + prompt)
  // -------------------------------------------------------------------------
  const modernWorkspace = defined(
    hubWorkspaces.list().find((ws) => ws.remote?.hostId === modernHostId),
  );
  const createdDraft1 = await hubRpc.dispatch("session/create", {
    args: { request: { workspaceId: modernWorkspace.workspaceId } },
  });
  assert.ok(createdDraft1.ok);
  const draft1Id = (createdDraft1.value as { sessionId: string }).sessionId;

  const draft1Proj = await hubRpc.dispatch("session/projections", {
    args: { request: { sessionId: draft1Id } },
  });
  assert.ok(draft1Proj.ok);
  const draft1Values = (draft1Proj.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(draft1Values.attachmentInput, { enabled: true });
  assert.deepEqual(draft1Values.imageLimits, WEB_IMAGE_LIMITS);
  assert.equal((draft1Values.remoteHost as { filePreview?: boolean }).filePreview, true);

  const draft1UploadRes = await fetch(
    `${hubHttp.origin}/api/session/uploadFileBinary?${new URLSearchParams({
      sessionId: draft1Id,
      name: "notes.txt",
    })}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("draft attachment contents"),
    },
  );
  assert.equal(draft1UploadRes.status, 200);
  const draft1Upload = c.remotePeerUploadResultSchema.parse(await draft1UploadRes.json());
  assert.equal(draft1Upload.ok, true);

  const boundEvents: Array<[string, string]> = [];
  const originalEmit = hubEvents.emit.bind(hubEvents);
  hubEvents.emit = (event: string, ...args: unknown[]) => {
    if (event === "codexhost/session-bound") {
      boundEvents.push([String(args[0]), String(args[1])]);
    }
    originalEmit(event, ...args);
  };

  // Attachment-only first turn (no text part) is permitted
  const draft1Prompt = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draft1Id,
        requestId: "req-draft-1",
        content: [{ type: "file", receiptId: draft1Upload.value.receiptId }],
      },
    },
  });
  assert.deepEqual(draft1Prompt, { ok: true, value: { accepted: true } });
  const draft1Bound = defined(boundEvents.find(([from]) => from === draft1Id));
  assert.ok(draft1Bound[1].startsWith("web-remote:"));
  assert.equal(modernPeer.promptHistory.length, 2);

  // -------------------------------------------------------------------------
  // 3. Draft creation succeeds, first prompt fails -> retry on canonical session reuses scope
  // -------------------------------------------------------------------------
  const createdDraft2 = await hubRpc.dispatch("session/create", {
    args: { request: { workspaceId: modernWorkspace.workspaceId } },
  });
  assert.ok(createdDraft2.ok);
  const draft2Id = (createdDraft2.value as { sessionId: string }).sessionId;

  const draft2UploadRes = await fetch(
    `${hubHttp.origin}/api/session/uploadFileBinary?${new URLSearchParams({
      sessionId: draft2Id,
      name: "retry.txt",
    })}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("retry me after first prompt failure"),
    },
  );
  assert.equal(draft2UploadRes.status, 200);
  const draft2Upload = c.remotePeerUploadResultSchema.parse(await draft2UploadRes.json());
  assert.equal(draft2Upload.ok, true);

  failNextPromptCount = 1;
  const failedFirstPrompt = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draft2Id,
        requestId: "req-draft-2-attempt-1",
        content: [
          { type: "file", receiptId: draft2Upload.value.receiptId },
          { type: "text", text: "first try" },
        ],
      },
    },
  });
  assert.equal(failedFirstPrompt.ok, false);
  assert.equal(failedFirstPrompt.error.code, "remote/transient-error");

  // Draft already bound to canonical session ID
  const draft2Bound = defined(boundEvents.find(([from]) => from === draft2Id));
  const canonicalDraft2Id = draft2Bound[1];

  // Retrying on the canonical session carries the retained scope so the receipt still resolves!
  const retryPrompt = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: canonicalDraft2Id,
        requestId: "req-draft-2-attempt-2",
        mode: "queue",
        content: [
          { type: "file", receiptId: draft2Upload.value.receiptId },
          { type: "text", text: "second try" },
        ],
      },
    },
  });
  assert.deepEqual(retryPrompt, { ok: true, value: { accepted: true } });
  assert.equal(modernPeer.promptHistory.length, 3);

  // -------------------------------------------------------------------------
  // 4. Legacy Peer without capabilities.attachments: upload, file prompt, attachment read, preview rejected
  // -------------------------------------------------------------------------
  const legacyUploadRes = await fetch(
    `${hubHttp.origin}/api/session/uploadFileBinary?${new URLSearchParams({
      sessionId: legacySessionId,
      name: "nope.png",
    })}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG_BYTES,
    },
  );
  assert.equal(legacyUploadRes.status, 200);
  const legacyUploadBody = c.remotePeerUploadResultSchema.parse(await legacyUploadRes.json());
  assert.equal(legacyUploadBody.ok, false);
  assert.equal(legacyUploadBody.error.code, "remote/attachments-unsupported");

  const legacyFilePrompt = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: legacySessionId,
        content: [{ type: "file", receiptId: "rcpt-x" }],
      },
    },
  });
  assert.equal(legacyFilePrompt.ok, false);
  assert.equal(legacyFilePrompt.error.code, "remote/attachments-unsupported");

  const legacyAttachmentRead = await hubRpc.dispatch("session/attachment", {
    args: {
      request: {
        sessionId: legacySessionId,
        attachmentId: "peer-image:abc",
      },
    },
  });
  assert.equal(legacyAttachmentRead.ok, false);
  assert.equal(legacyAttachmentRead.error.code, "remote/attachments-unsupported");

  const legacyPreview = await fetch(
    `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
      sessionId: legacySessionId,
      path: "sub/screenshot.png",
    })}`,
  );
  assert.equal(legacyPreview.status, 404);

  // Legacy Peer draft also reports attachmentInput disabled and rejects upload
  const legacyWorkspaceEntry = defined(
    hubWorkspaces.list().find((ws) => ws.remote?.hostId === legacyHostId),
  );
  const createdLegacyDraft = await hubRpc.dispatch("session/create", {
    args: { request: { workspaceId: legacyWorkspaceEntry.workspaceId } },
  });
  assert.ok(createdLegacyDraft.ok);
  const legacyDraftId = (createdLegacyDraft.value as { sessionId: string }).sessionId;
  const legacyDraftProj = await hubRpc.dispatch("session/projections", {
    args: { request: { sessionId: legacyDraftId } },
  });
  assert.ok(legacyDraftProj.ok);
  const legacyDraftValues = (legacyDraftProj.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(legacyDraftValues.attachmentInput, { enabled: false });
  assert.equal((legacyDraftValues.remoteHost as { filePreview?: boolean }).filePreview, false);

  // -------------------------------------------------------------------------
  // 5. Desktop remote session: upload, file prompt, preview rejected
  // -------------------------------------------------------------------------
  const desktopUploadRes = await fetch(
    `${hubHttp.origin}/api/session/uploadFileBinary?${new URLSearchParams({
      sessionId: desktopSessionId,
      name: "desk.png",
    })}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG_BYTES,
    },
  );
  assert.equal(desktopUploadRes.status, 200);
  const desktopUploadBody = c.remotePeerUploadResultSchema.parse(await desktopUploadRes.json());
  assert.equal(desktopUploadBody.ok, false);
  assert.equal(desktopUploadBody.error.code, "remote/attachments-unsupported");

  const desktopFilePrompt = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: desktopSessionId,
        content: [{ type: "file", receiptId: "rcpt-desktop" }],
      },
    },
  });
  assert.equal(desktopFilePrompt.ok, false);
  assert.equal(desktopFilePrompt.error.code, "remote/attachments-unsupported");

  const desktopPreview = await fetch(
    `${hubHttp.origin}${c.REMOTE_PEER_FILE_PROXY_PATH}?${new URLSearchParams({
      sessionId: desktopSessionId,
      path: "screenshot.png",
    })}`,
  );
  assert.equal(desktopPreview.status, 404);

  // -------------------------------------------------------------------------
  // 6. Encoded image part (type: "image") rejected as REMOTE_ENCODED_IMAGE_UNSUPPORTED
  // -------------------------------------------------------------------------
  const encodedOnExisting = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: modernSessionId,
        content: [{ type: "image", mediaType: "image/png", data: PNG }],
      },
    },
  });
  assert.equal(encodedOnExisting.ok, false);
  assert.equal(encodedOnExisting.error.code, "session/attachment-invalid");
  assert.equal(
    (encodedOnExisting.error.details as { reason?: string }).reason,
    "REMOTE_ENCODED_IMAGE_UNSUPPORTED",
  );

  const createdDraft3 = await hubRpc.dispatch("session/create", {
    args: { request: { workspaceId: modernWorkspace.workspaceId } },
  });
  assert.ok(createdDraft3.ok);
  const draft3Id = (createdDraft3.value as { sessionId: string }).sessionId;
  const encodedOnDraft = await hubRpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draft3Id,
        content: [{ type: "image", mediaType: "image/png", data: PNG }],
      },
    },
  });
  assert.equal(encodedOnDraft.ok, false);
  assert.equal(encodedOnDraft.error.code, "session/attachment-invalid");
  assert.equal(
    (encodedOnDraft.error.details as { reason?: string }).reason,
    "REMOTE_ENCODED_IMAGE_UNSUPPORTED",
  );
});
