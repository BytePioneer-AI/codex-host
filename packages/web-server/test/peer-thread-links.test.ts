import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { REMOTE_PEERS_METHODS, type RemoteSessionOperation } from "@codexhost/shared-contracts";
import { PeerHostManager } from "../src/peer-host-manager.ts";
import { PeerHostStore } from "../src/peer-host-store.ts";
import {
  translateThreadLinksForPeer,
  translateThreadLinksFromPeer,
} from "../src/peer-thread-links.ts";
import { RemotePeerAttachments } from "../src/remote-peer-attachments.ts";
import { remoteSessionId, RemoteSessions } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";

it("translates outbound thread:// links across self, paired, unpaired, third-host, Markdown, and non-peer links", () => {
  const hostIdB = "remote-peer:peer-b-on-a";
  const hostIdBAlt = "remote-peer:peer-b-alt-on-a";
  const hostIdC = "remote-peer:peer-c-on-a";
  const hostIdD = "remote-peer:peer-d-on-a";
  const nodeMap: Record<string, string> = {
    local: "node-a",
    [hostIdB]: "node-b",
    [hostIdBAlt]: "node-b",
    [hostIdC]: "node-c",
    [hostIdD]: "node-d",
  };

  // Legacy Peer B (no nodeId, no peerNodes): self-reference still translates to local.
  assert.equal(
    translateThreadLinksForPeer(
      `Check [@On B](thread://t-b?hostId=${encodeURIComponent(hostIdB)}) and thread://t-a?hostId=local.`,
      { targetHostId: hostIdB, nodeIdForHostId: (id) => nodeMap[id] },
    ),
    "Check [@On B](thread://t-b?hostId=local) and thread://t-a?hostId=local.",
  );

  // Paired A <-> B and B <-> C, while D is NOT paired on B.
  const ctx = {
    targetHostId: hostIdB,
    targetNodeId: "node-b",
    targetPeerNodes: {
      "remote-peer:peer-a-on-b": "node-a",
      "remote-peer:peer-c-on-b": "node-c",
    },
    nodeIdForHostId: (id: string) => nodeMap[id],
  };

  // Same-node alt hostId -> local.
  assert.equal(
    translateThreadLinksForPeer(`thread://t-b2?hostId=${encodeURIComponent(hostIdBAlt)}`, ctx),
    "thread://t-b2?hostId=local",
  );

  // Mixed Markdown + bare links + Chinese/English punctuation + Desktop SSH + non-thread URLs.
  const mixed = [
    "看下 [@A 会话](thread://t-a?hostId=local)，",
    `再看 [@B 会话](thread://t-b?hostId=${encodeURIComponent(hostIdB)}) 和 `,
    `thread://t-c?hostId=${encodeURIComponent(hostIdC)}；`,
    `未互配 D: thread://t-d?hostId=${encodeURIComponent(hostIdD)}。`,
    "Desktop: [@SSH](thread://t-ssh?hostId=remote-ssh%3Abox) 和 thread://t-ctrl?hostId=remote-control%3Adev.",
    "保留: https://example.com/thread://x?hostId=local codex://threads/t-1 thread://bad?hostId=%ZZ thread://q?hostId=local&extra=1 thread://f?hostId=local#hash",
  ].join("");

  assert.equal(
    translateThreadLinksForPeer(mixed, ctx),
    [
      `看下 [@A 会话](thread://t-a?hostId=${encodeURIComponent("remote-peer:peer-a-on-b")})，`,
      "再看 [@B 会话](thread://t-b?hostId=local) 和 ",
      `thread://t-c?hostId=${encodeURIComponent("remote-peer:peer-c-on-b")}；`,
      `未互配 D: thread://t-d?hostId=${encodeURIComponent(hostIdD)}。`,
      "Desktop: [@SSH](thread://t-ssh?hostId=remote-ssh%3Abox) 和 thread://t-ctrl?hostId=remote-control%3Adev.",
      "保留: https://example.com/thread://x?hostId=local codex://threads/t-1 thread://bad?hostId=%ZZ thread://q?hostId=local&extra=1 thread://f?hostId=local#hash",
    ].join(""),
  );

  // Unpaired A -> B (B has no peerNodes entry for A): local stays local.
  assert.equal(
    translateThreadLinksForPeer("[@A](thread://t-a?hostId=local)", {
      targetHostId: hostIdB,
      targetNodeId: "node-b",
      targetPeerNodes: { "remote-peer:peer-c-on-b": "node-c" },
      nodeIdForHostId: (id) => nodeMap[id],
    }),
    "[@A](thread://t-a?hostId=local)",
  );
});

it("unambiguously restores inbound remote-peer:* links while leaving hostId=local untouched", () => {
  const aHostForNode = (nodeId: string): string | undefined => {
    if (nodeId === "node-a") return "local";
    if (nodeId === "node-c") return "remote-peer:peer-c-on-a";
    return undefined;
  };
  const bPeerNodes = {
    "remote-peer:peer-a-on-b": "node-a",
    "remote-peer:peer-c-on-b": "node-c",
    "remote-peer:peer-e-on-b": "node-e", // unknown on A
  };

  const fromB = [
    `[@A](thread://t-a?hostId=${encodeURIComponent("remote-peer:peer-a-on-b")}) `,
    `[@C](thread://t-c?hostId=${encodeURIComponent("remote-peer:peer-c-on-b")}) `,
    `[@E](thread://t-e?hostId=${encodeURIComponent("remote-peer:peer-e-on-b")}) `,
    "[@Local](thread://t-local?hostId=local)",
  ].join("");

  assert.equal(
    translateThreadLinksFromPeer(fromB, {
      sourcePeerNodes: bPeerNodes,
      hostIdForNodeId: aHostForNode,
    }),
    [
      "[@A](thread://t-a?hostId=local) ",
      `[@C](thread://t-c?hostId=${encodeURIComponent("remote-peer:peer-c-on-a")}) `,
      `[@E](thread://t-e?hostId=${encodeURIComponent("remote-peer:peer-e-on-b")}) `,
      "[@Local](thread://t-local?hostId=local)",
    ].join(""),
  );

  // Unpaired B (no peerNodes): hostId=local sent verbatim from A is never mis-rewritten on readback.
  assert.equal(
    translateThreadLinksFromPeer("[@A](thread://t-a?hostId=local)", {
      sourcePeerNodes: undefined,
      hostIdForNodeId: aHostForNode,
    }),
    "[@A](thread://t-a?hostId=local)",
  );
});

it("translates outbound and inbound remote delegation mention links across peer perspectives", () => {
  const hostIdB = "remote-peer:peer-b-on-a";
  const hostIdC = "remote-peer:peer-c-on-a";
  const hostIdD = "remote-peer:peer-d-on-a";
  const nodeMap: Record<string, string> = {
    local: "node-a",
    [hostIdB]: "node-b",
    [hostIdC]: "node-c",
    [hostIdD]: "node-d",
  };
  const outCtx = {
    targetHostId: hostIdB,
    targetNodeId: "node-b",
    targetPeerNodes: {
      "remote-peer:peer-a-on-b": "node-a",
      "remote-peer:peer-c-on-b": "node-c",
    },
    nodeIdForHostId: (id: string) => nodeMap[id],
  };

  const outbound = [
    "[@本机 · Codex](subagent://codexhost-remote/local/codex) ",
    "[@本机](subagent://codexhost-remote/local) ",
    `[@Mac Studio · Pi](subagent://codexhost-remote/${encodeURIComponent(hostIdB)}/pi) `,
    `[@Home Mini · Antigravity](subagent://codexhost-remote/${encodeURIComponent(hostIdC)}/antigravity) `,
    `[@Unpaired](subagent://codexhost-remote/${encodeURIComponent(hostIdD)}/codex)`,
  ].join("");

  assert.equal(
    translateThreadLinksForPeer(outbound, outCtx),
    [
      `[@本机 · Codex](subagent://codexhost-remote/${encodeURIComponent("remote-peer:peer-a-on-b")}/codex) `,
      `[@本机](subagent://codexhost-remote/${encodeURIComponent("remote-peer:peer-a-on-b")}) `,
      "[@Mac Studio · Pi](subagent://codexhost.pi) ",
      `[@Home Mini · Antigravity](subagent://codexhost-remote/${encodeURIComponent("remote-peer:peer-c-on-b")}/antigravity) `,
      `[@Unpaired](subagent://codexhost-remote/${encodeURIComponent(hostIdD)}/codex)`,
    ].join(""),
  );

  const inbound = [
    `[@A](subagent://codexhost-remote/${encodeURIComponent("remote-peer:peer-a-on-b")}/codex) `,
    `[@C](subagent://codexhost-remote/${encodeURIComponent("remote-peer:peer-c-on-b")}) `,
    "[@Local](subagent://codexhost-remote/local)",
  ].join("");
  assert.equal(
    translateThreadLinksFromPeer(inbound, {
      sourcePeerNodes: outCtx.targetPeerNodes,
      hostIdForNodeId: (nodeId) =>
        nodeId === "node-a" ? "local" : nodeId === "node-c" ? hostIdC : undefined,
    }),
    [
      "[@A](subagent://codexhost-remote/local/codex) ",
      `[@C](subagent://codexhost-remote/${encodeURIComponent(hostIdC)}) `,
      "[@Local](subagent://codexhost-remote/local)",
    ].join(""),
  );
});

it("translates RemoteSessions outbound paths for remote-peer:* while preserving Desktop SSH and projecting B history back to A", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-links-sessions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tokenB = "peer-b-token";
  const epochB = randomUUID();
  const nodeA = "node-a-id";
  const nodeB = "node-b-id";
  const hostIdAOnB = "remote-peer:peer-a-on-b";
  let peerNodesB: Record<string, string> = { [hostIdAOnB]: nodeA };

  const receivedPeerPrompts: Array<{ method: string; params: Record<string, unknown> }> = [];
  const receivedPeerAttachmentPrompts: Array<Record<string, unknown>> = [];

  const serverB = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${tokenB}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/peer/v1/manifest") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: "0.26.1",
          epoch: epochB,
          platform: process.platform,
          hostname: "node-b",
          homeDir: root,
          nodeId: nodeB,
          peerNodes: peerNodesB,
          projects: [{ id: "proj-b", name: "ProjB", path: root, threadIds: ["t-b-1"] }],
          capabilities: { attachments: 1 },
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/events") {
      res.writeHead(200);
      res.write(
        `${JSON.stringify({ type: "hello", version: 1, cursor: { epoch: epochB, sequence: 1 }, reset: true })}\n`,
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
      string,
      unknown
    >;
    if (url.pathname === "/api/peer/v1/prompt") {
      receivedPeerAttachmentPrompts.push(body);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, value: { accepted: true } }));
      return;
    }
    if (url.pathname === "/api/ch/v1/snapshot") {
      const threadId = String(body.threadId ?? "t-b-1");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          result: {
            cursor: { epoch: epochB, sequence: 2 },
            thread: {
              id: threadId,
              cwd: root,
              modelProvider: "codex",
              createdAt: 100,
              updatedAt: 101,
              status: { type: "idle" },
              turns: [],
            },
            turnsPage: {
              data: [
                {
                  id: "turn-1",
                  status: "completed",
                  items: [
                    {
                      id: "u-1",
                      type: "userMessage",
                      content: [
                        {
                          type: "text",
                          text: `From A: [@A](thread://t-a-1?hostId=${encodeURIComponent(hostIdAOnB)}) and [@Local](thread://t-raw?hostId=local)`,
                        },
                      ],
                    },
                    {
                      id: "a-1",
                      type: "agentMessage",
                      phase: "final_answer",
                      text: `Reply pointing to [@A](thread://t-a-1?hostId=${encodeURIComponent(hostIdAOnB)}) and [@B](thread://t-b-2?hostId=local)`,
                    },
                  ],
                },
              ],
              nextCursor: null,
            },
            queue: {
              pausedReason: null,
              items: [
                {
                  id: "q-1",
                  clientUserMessageId: "req-q-1",
                  input: [
                    {
                      type: "text",
                      text: `Queued: thread://t-a-2?hostId=${encodeURIComponent(hostIdAOnB)}`,
                    },
                  ],
                },
              ],
            },
            configuration: {},
            interactions: [],
          },
        }),
      );
      return;
    }
    if (url.pathname === "/api/ch/v1/rpc") {
      const method = String(body.method ?? "");
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (method === "thread/start") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            result: {
              thread: {
                id: `t-b-new-${receivedPeerPrompts.length + receivedPeerAttachmentPrompts.length + 1}`,
                cwd: root,
                modelProvider: "codex",
                createdAt: 100,
                updatedAt: 100,
                status: { type: "idle" },
                turns: [],
              },
            },
          }),
        );
        return;
      }
      if (method === "turn/start" || method === "thread/queue/add" || method === "turn/steer") {
        receivedPeerPrompts.push({ method, params });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            result:
              method === "thread/queue/add"
                ? {
                    queuedSubmission: {
                      id: "qs-1",
                      clientUserMessageId: params.clientUserMessageId,
                    },
                  }
                : { turn: { id: "turn-next" }, turnId: params.expectedTurnId ?? "turn-next" },
          }),
        );
        return;
      }
      if (method === "codexhost/thread/catalog/read") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            result: {
              threads: [
                {
                  id: "t-b-1",
                  cwd: root,
                  modelProvider: "codex",
                  createdAt: 100,
                  updatedAt: 101,
                  status: { type: "idle" },
                },
              ],
              ownership: [],
              officialCursor: { live: null },
              archivedThreadIds: [],
            },
          }),
        );
        return;
      }
      if (method === "codexhost/thread/tree/read") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ result: { parents: {} } }));
        return;
      }
      if (method === "codexhost/thread/inspect") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ result: { owner: "codex" } }));
        return;
      }
      if (method === "codexhost/harness/plugins/list") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ result: { plugins: [] } }));
        return;
      }
      if (method === "codexhost/harness/inspect") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            result: {
              status: "ready",
              catalog: {
                models: [{ ref: { id: "gpt-5" }, label: "GPT-5" }],
                thinkingOptions: [],
              },
              capabilities: {
                configuration: {
                  selectModel: true,
                  selectThinkingOption: false,
                  selectPermissionMode: false,
                  permissionModeScope: "live",
                },
                history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
              },
            },
          }),
        );
        return;
      }
      if (method === "model/list") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ result: { data: [], nextCursor: null } }));
        return;
      }
      if (method === "codexhost/thread/usage/inspect") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ result: {} }));
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ result: {} }));
      return;
    }
    res.writeHead(404).end();
  });
  serverB.listen(0, "127.0.0.1");
  await once(serverB, "listening");
  const originB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;

  const dataA = new DataDir(join(root, "a-data"));
  const eventsA = new EventHub(join(root, "a-data"));
  const workspacesA = new Workspaces(dataA, root, true);
  const peerAttachments = new RemotePeerAttachments();
  const managerA = new PeerHostManager(new PeerHostStore(dataA), async () => [], eventsA, {
    allowLoopback: true,
    localNodeId: nodeA,
    projector: (threadId) => peerAttachments.projector(threadId),
  });
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  rpc.register("session/prompt", () => {
    throw new Error("local session/prompt should not handle remote sessions");
  });
  rpc.register("session/create", () => {
    throw new Error("local session/create should not handle remote workspaces");
  });
  managerA.register(rpc);

  const added = await rpc.dispatch(
    REMOTE_PEERS_METHODS.add,
    { args: { connectionUrl: `${originB}/#token=${tokenB}`, name: "Node B" } },
    { local: true, credential: "local", release() {} },
  );
  assert.equal(added.ok, true);
  const hostIdB = (added.value as { peer: { hostId: string } }).peer.hostId;

  const desktopOps: RemoteSessionOperation[] = [];
  const compositeCall = async (op: RemoteSessionOperation) => {
    if (op.kind === "hosts") {
      return [
        ...managerA.hosts(),
        {
          hostId: "remote-ssh:box",
          online: true,
          epoch: "ssh-epoch",
          displayName: "SSH Box",
          projects: [],
        },
      ];
    }
    if (op.hostId.startsWith("remote-peer:")) return managerA.call(op);
    desktopOps.push(op);
    if (op.kind === "list") {
      return {
        data: [
          {
            id: "t-ssh-1",
            cwd: "/srv/app",
            modelProvider: "codex",
            createdAt: 100,
            updatedAt: 100,
            status: { type: "idle" },
          },
        ],
        nextCursor: null,
        epoch: "ssh-epoch",
      };
    }
    if (op.kind === "read") {
      return {
        result: {
          thread: {
            id: op.threadId,
            cwd: "/srv/app",
            modelProvider: "codex",
            createdAt: 100,
            updatedAt: 100,
            status: { type: "idle" },
            turns: [],
          },
        },
        epoch: "ssh-epoch",
        requests: [],
      };
    }
    return { turn: { id: "ssh-turn-1" } };
  };

  const remoteSessions = new RemoteSessions(
    eventsA,
    compositeCall,
    workspacesA,
    managerA,
    peerAttachments,
  );
  remoteSessions.install(rpc, streams);
  t.after(() => {
    remoteSessions.close();
    managerA.close();
    serverB.closeAllConnections();
    serverB.close();
  });

  await remoteSessions.refresh();
  const peerSessionId = remoteSessionId(hostIdB, "t-b-1");
  const sshSessionId = remoteSessionId("remote-ssh:box", "t-ssh-1");
  const linkToA = "[@A](thread://t-a-1?hostId=local)";
  const linkToB = `[@B](thread://t-b-1?hostId=${encodeURIComponent(hostIdB)})`;
  const expectedAOnB = `[@A](thread://t-a-1?hostId=${encodeURIComponent(hostIdAOnB)})`;
  const expectedBOnB = "[@B](thread://t-b-1?hostId=local)";

  // 1. Follow-up plain text session/prompt -> translated.
  const plainSent = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: peerSessionId,
        content: [{ type: "text", text: `Plain: ${linkToA} ${linkToB}` }],
      },
    },
  });
  assert.equal(plainSent.ok, true);
  assert.deepEqual(receivedPeerPrompts.at(-1)?.params, {
    threadId: "t-b-1",
    input: [{ type: "text", text: `Plain: ${expectedAOnB} ${expectedBOnB}`, text_elements: [] }],
  });

  // 2. Follow-up mode="queue" (deliverRemoteInput) -> translated.
  const queuedSent = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: peerSessionId,
        mode: "queue",
        requestId: "req-queue-1",
        content: [{ type: "text", text: `Queue: ${linkToA} ${linkToB}` }],
      },
    },
  });
  assert.equal(queuedSent.ok, true);
  assert.equal(receivedPeerPrompts.at(-1)?.method, "thread/queue/add");
  assert.deepEqual(receivedPeerPrompts.at(-1)?.params?.input, [
    { type: "text", text: `Queue: ${expectedAOnB} ${expectedBOnB}`, text_elements: [] },
  ]);

  // 3. Follow-up with attachments (attachments.prompt) -> text parts translated, file part untouched.
  const attachSent = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: peerSessionId,
        requestId: "req-attach-1",
        content: [
          { type: "text", text: `Attach: ${linkToA} ${linkToB}` },
          { type: "file", receiptId: "receipt-1" },
        ],
      },
    },
  });
  assert.equal(attachSent.ok, true);
  assert.deepEqual(receivedPeerAttachmentPrompts.at(-1)?.content, [
    { type: "text", text: `Attach: ${expectedAOnB} ${expectedBOnB}` },
    { type: "file", receiptId: "receipt-1" },
  ]);

  // 4. Draft firstTurn (both plain text and with attachments) -> translated.
  const wsGroup = workspacesA.list().find((w) => w.remote?.hostId === hostIdB);
  assert.ok(wsGroup, "expected remote workspace group for Peer B");
  const draft1 = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: wsGroup.workspaceId } },
  });
  assert.equal(draft1.ok, true);
  const firstPlain = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: (draft1.value as { sessionId: string }).sessionId,
        content: [{ type: "text", text: `First: ${linkToA} ${linkToB}` }],
      },
    },
  });
  assert.equal(firstPlain.ok, true, JSON.stringify(firstPlain));
  assert.deepEqual(receivedPeerPrompts.at(-1)?.params?.input, [
    { type: "text", text: `First: ${expectedAOnB} ${expectedBOnB}`, text_elements: [] },
  ]);

  const draft2 = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: wsGroup.workspaceId } },
  });
  assert.equal(draft2.ok, true);
  const firstAttach = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: (draft2.value as { sessionId: string }).sessionId,
        content: [
          { type: "text", text: `FirstAttach: ${linkToA} ${linkToB}` },
          { type: "file", receiptId: "receipt-2" },
        ],
      },
    },
  });
  assert.equal(firstAttach.ok, true);
  assert.deepEqual(receivedPeerAttachmentPrompts.at(-1)?.content, [
    { type: "text", text: `FirstAttach: ${expectedAOnB} ${expectedBOnB}` },
    { type: "file", receiptId: "receipt-2" },
  ]);

  // 5. Codex Desktop SSH remote prompt must NOT translate links.
  const sshPrompt = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: sshSessionId,
        content: [{ type: "text", text: `SSH: ${linkToA} ${linkToB}` }],
      },
    },
  });
  assert.equal(sshPrompt.ok, true);
  const sshOp = desktopOps.find((op) => op.kind === "prompt");
  assert.equal(sshOp?.kind, "prompt");
  assert.equal(sshOp.text, `SSH: ${linkToA} ${linkToB}`);

  // 6. Inbound history projection (B -> A): user message, assistant message, and queued inbox
  //    restore remote-peer:peer-a-on-b -> local, while leaving hostId=local untouched.
  const view = await remoteSessions.read(peerSessionId, true);
  const userEvent = view.log.events.find((e) => e.type === "user/message");
  const assistantEvent = view.log.events.find((e) => e.type === "assistant/message");
  const userContent = (userEvent?.data as { content?: Array<{ type: string; text?: string }> })
    ?.content;
  const assistantContent = (
    assistantEvent?.data as { message?: { content?: Array<{ type: string; text?: string }> } }
  )?.message?.content;
  assert.equal(
    userContent?.[0]?.text,
    "From A: [@A](thread://t-a-1?hostId=local) and [@Local](thread://t-raw?hostId=local)",
  );
  assert.equal(
    assistantContent?.[0]?.text,
    "Reply pointing to [@A](thread://t-a-1?hostId=local) and [@B](thread://t-b-2?hostId=local)",
  );
  const inbox = view.log.projections.inbox as {
    "next-turn"?: Array<{ content?: Array<{ type: string; text?: string }> }>;
  };
  assert.equal(inbox["next-turn"]?.[0]?.content?.[0]?.text, "Queued: thread://t-a-2?hostId=local");

  // 7. When B is NOT paired with A (empty peerNodes), hostId=local in B history stays untouched.
  peerNodesB = {};
  await managerA.client(hostIdB)?.probe();
  const unpairedView = await remoteSessions.read(peerSessionId, true);
  const unpairedAssistant = unpairedView.log.events.find((e) => e.type === "assistant/message");
  const unpairedText = (
    unpairedAssistant?.data as { message?: { content?: Array<{ type: string; text?: string }> } }
  )?.message?.content?.[0]?.text;
  assert.equal(
    unpairedText,
    `Reply pointing to [@A](thread://t-a-1?hostId=${encodeURIComponent(hostIdAOnB)}) and [@B](thread://t-b-2?hostId=local)`,
  );
});
