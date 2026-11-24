import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DshWebServices } from "../src/dsh-web-services.ts";
import { peerEndpoint } from "../src/peer-manifest.ts";
import {
  PEER_WORKSPACE_FILES_HEADER,
  servePeerWorkspaceFiles,
  type PeerWorkspaceFilesDsh,
} from "../src/peer-workspace-files-http.ts";
import {
  RemotePeerWorkspaceFiles,
  type PeerWorkspaceFileEndpoint,
  type RemoteWorkspaceFileSessionResolver,
} from "../src/remote-peer-workspace-files.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamSink } from "../src/transport.ts";
import {
  downloadWorkspaceFile,
  issueWorkspaceDownloadTicket,
  WorkspaceDownloadTickets,
} from "../src/workspace-file-actions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

function makePeer(
  origin: string,
  overrides: Partial<PeerWorkspaceFileEndpoint> & { enabled?: boolean; token?: string } = {},
): PeerWorkspaceFileEndpoint {
  return {
    record: {
      peerId: "peer-1",
      name: "Workstation",
      origin,
      token: overrides.token ?? "secret-peer-token",
      enabled: overrides.enabled ?? true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    state: overrides.state ?? "connected",
    manifest:
      "manifest" in overrides
        ? overrides.manifest
        : {
            version: "0.26.0",
            platform: process.platform,
            hostname: "workstation",
            epoch: "epoch-1",
            projects: [],
            capabilities: { attachments: 1, workspaceFiles: 1, officePreview: 1 },
          },
  };
}

async function startHttpServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("Hub proxies Typert RPCs, multipart binaries (readBytes & officeToPdf/render), rpcId, non-2xx errors, and streaming downloads", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-hub-peer-files-"));
  const workspace = join(outer, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "# Hello remote\n");
  await writeFile(join(workspace, "deck.pptx"), Buffer.from("fake-pptx-source"));
  const largeDownloadBytes = Buffer.alloc(128 * 1024, 0x42);
  await writeFile(join(workspace, "large-report.bin"), largeDownloadBytes);

  const realDsh = await DshWebServices.open({
    workspaceRoot: workspace,
    threadWorkspace: (id) => (id === "remote-t1" ? workspace : undefined),
    fileWorkspace: (id) => (id === "remote-t1" ? workspace : undefined),
  });

  const fakePdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const observedPeerMethods: string[] = [];
  const combinedDsh: PeerWorkspaceFilesDsh = {
    async fetchMethod(method, body, signal) {
      observedPeerMethods.push(method);
      if (method === "officeToPdf/render") {
        const parsed = JSON.parse(body) as { rpcId: string; payload: { args: { path: string } } };
        if (parsed.payload.args.path.endsWith("broken.docx")) {
          return new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: parsed.rpcId,
              result: {
                ok: false,
                error: {
                  code: "document-render/failed",
                  message: "Office conversion failed.",
                  details: { reason: "invalid-document" },
                },
              },
            }),
            { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
          );
        }
        const form = new FormData();
        form.set("bytes-0", new Blob([fakePdfBytes]));
        form.set(
          "metadata",
          JSON.stringify({
            type: "server-response",
            rpcId: parsed.rpcId,
            result: {
              ok: true,
              value: {
                absolutePath: parsed.payload.args.path,
                version: "v1",
                offset: 0,
                eof: true,
                bytes: fakePdfBytes.byteLength,
                missingFonts: ["Noto Sans SC"],
                generation: "peer-gen-1",
              },
            },
            attachments: [{ path: ["data"], codec: "bytes", part: "bytes-0" }],
          }),
        );
        return new Response(form);
      }
      return realDsh.fetchMethod(method, body, signal);
    },
  };
  await writeFile(join(workspace, "broken.docx"), "corrupted");

  let peerAuthSeen = "";
  const peerServer = await startHttpServer((req, res) => {
    peerAuthSeen = req.headers.authorization ?? "";
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/api/peer/v1/workspace-files/rpc") {
      void servePeerWorkspaceFiles(req, res, "rpc", {
        resolveWorkspaceRoot: (id) => (id === "remote-t1" ? workspace : undefined),
        dsh: combinedDsh,
      });
      return;
    }
    if (pathname === "/api/peer/v1/workspace-files/download") {
      void servePeerWorkspaceFiles(req, res, "download", {
        resolveWorkspaceRoot: (id) => (id === "remote-t1" ? workspace : undefined),
        dsh: combinedDsh,
      });
      return;
    }
    res.writeHead(404).end();
  });

  const remoteId = remoteSessionId("remote-peer:peer-1", "remote-t1");
  const boundDraftId = "web-remote:draft-bound-1";
  let currentPeer: PeerWorkspaceFileEndpoint | undefined = makePeer(peerServer.url);
  let now = 10_000;
  const tickets = new WorkspaceDownloadTickets(() => now);
  const resolver: RemoteWorkspaceFileSessionResolver = {
    resolveDraftCanonicalId: (sessionId) =>
      sessionId === boundDraftId
        ? { isDraft: true, canonicalId: remoteId, hostId: "remote-peer:peer-1" }
        : { isDraft: false },
    peerClient: (hostId) => (hostId === "remote-peer:peer-1" ? currentPeer : undefined),
  };
  const proxy = new RemotePeerWorkspaceFiles(resolver);

  let localFallbackCalls = 0;
  const hubServer = await startHttpServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname === "/api/workspace-file/download-ticket" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void issueWorkspaceDownloadTicket(
          res,
          Buffer.concat(chunks).toString("utf8"),
          () => undefined,
          tickets,
          "owner-1",
          proxy,
        );
      });
      return;
    }
    if (reqUrl.pathname === "/api/workspace-file/download") {
      const ticket = reqUrl.searchParams.get("ticket");
      if (ticket !== null) {
        const grant = tickets.resolve(ticket);
        if (!grant) {
          res.writeHead(401).end("download link expired");
          return;
        }
        void downloadWorkspaceFile(req, res, reqUrl, () => undefined, grant, proxy);
        return;
      }
      void downloadWorkspaceFile(req, res, reqUrl, () => undefined, undefined, proxy);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (await proxy.handleApiRequest(req, body, res)) return;
        localFallbackCalls += 1;
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ local: true }));
      })();
    });
  });

  try {
    // 1. Local session is NOT intercepted
    const localRes = await fetch(`${hubServer.url}/api/workspaceFiles/stat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "local-1",
        method: "workspaceFiles/stat",
        payload: { args: { workspaceFileScopeId: "local-thread", path: "notes.md" } },
      }),
    });
    assert.deepEqual(await localRes.json(), { local: true });
    assert.equal(localFallbackCalls, 1);

    // 2. Bound remote draft resolves canonicalId and reads remote bytes as multipart/form-data
    const readBytesRes = await fetch(`${hubServer.url}/api/workspaceFiles/readBytes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "hub-rpc-bytes",
        method: "workspaceFiles/readBytes",
        payload: { args: { workspaceFileScopeId: boundDraftId, path: "notes.md", options: {} } },
      }),
    });
    assert.equal(readBytesRes.status, 200);
    assert.equal(peerAuthSeen, "Bearer secret-peer-token");
    assert.match(readBytesRes.headers.get("content-type") ?? "", /^multipart\/form-data;/u);
    const bytesForm = await readBytesRes.formData();
    const bytesMeta = JSON.parse(String(bytesForm.get("metadata"))) as {
      rpcId: string;
      result: { ok: boolean };
      attachments: Array<{ part: string }>;
    };
    assert.equal(bytesMeta.rpcId, "hub-rpc-bytes");
    assert.equal(bytesMeta.result.ok, true);
    const bytesAttachment = bytesMeta.attachments[0];
    assert.ok(bytesAttachment);
    const blob = bytesForm.get(bytesAttachment.part);
    assert.ok(blob instanceof Blob);
    assert.equal(await blob.text(), "# Hello remote\n");

    // 3. officeToPdf/render streams multipart PDF and preserves missingFonts + generation + rpcId
    const officeRes = await fetch(`${hubServer.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "hub-office-1",
        method: "officeToPdf/render",
        payload: {
          args: { workspaceFileScopeId: remoteId, path: "deck.pptx", priority: "foreground" },
        },
      }),
    });
    assert.equal(officeRes.status, 200);
    assert.match(officeRes.headers.get("content-type") ?? "", /^multipart\/form-data;/u);
    const officeForm = await officeRes.formData();
    const officeMeta = JSON.parse(String(officeForm.get("metadata"))) as {
      rpcId: string;
      result: { ok: boolean; value: { generation: string; missingFonts: string[] } };
      attachments: Array<{ part: string }>;
    };
    assert.equal(officeMeta.rpcId, "hub-office-1");
    assert.equal(officeMeta.result.value.generation, "peer-gen-1");
    assert.deepEqual(officeMeta.result.value.missingFonts, ["Noto Sans SC"]);
    const officeAttachment = officeMeta.attachments[0];
    assert.ok(officeAttachment);
    const pdfPart = officeForm.get(officeAttachment.part);
    assert.ok(pdfPart instanceof Blob);
    assert.deepEqual(Buffer.from(await pdfPart.arrayBuffer()), fakePdfBytes);
    assert.ok(observedPeerMethods.includes("officeToPdf/render"));

    // 4. Non-2xx Typert error envelope from Peer preserves rpcId, code, and error.details
    const brokenOfficeRes = await fetch(`${hubServer.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "hub-office-err",
        method: "officeToPdf/render",
        payload: {
          args: { workspaceFileScopeId: remoteId, path: "broken.docx", priority: "foreground" },
        },
      }),
    });
    assert.equal(brokenOfficeRes.status, 200);
    const brokenJson = (await brokenOfficeRes.json()) as {
      rpcId: string;
      result: { ok: boolean; error: { code: string; details: { reason: string } } };
    };
    assert.equal(brokenJson.rpcId, "hub-office-err");
    assert.equal(brokenJson.result.ok, false);
    assert.equal(brokenJson.result.error.code, "document-render/failed");
    assert.equal(brokenJson.result.error.details.reason, "invalid-document");

    // 5. Direct GET and HEAD downloads stream bytes cleanly without leaking peer token
    const directQuery = new URLSearchParams({ sessionId: remoteId, path: "large-report.bin" });
    const directHead = await fetch(
      `${hubServer.url}/api/workspace-file/download?${directQuery.toString()}`,
      { method: "HEAD" },
    );
    assert.equal(directHead.status, 200);
    assert.equal(directHead.headers.get("content-length"), String(largeDownloadBytes.length));
    const directGet = await fetch(
      `${hubServer.url}/api/workspace-file/download?${directQuery.toString()}`,
    );
    assert.equal(directGet.status, 200);
    assert.deepEqual(Buffer.from(await directGet.arrayBuffer()), largeDownloadBytes);

    // 6. Download-ticket flow: mint -> HEAD + GET reuse -> Peer offline re-validation -> revokeOwner & TTL expiry
    const ticketRes = await fetch(`${hubServer.url}/api/workspace-file/download-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: remoteId, path: "large-report.bin" }),
    });
    assert.equal(ticketRes.status, 200);
    const ticketJson = (await ticketRes.json()) as { ticket: string; name: string; size: number };
    assert.equal(ticketJson.name, "large-report.bin");
    assert.equal(ticketJson.size, largeDownloadBytes.length);
    assert.ok(!ticketJson.ticket.includes("secret-peer-token"));

    const ticketHead = await fetch(
      `${hubServer.url}/api/workspace-file/download?ticket=${encodeURIComponent(ticketJson.ticket)}`,
      { method: "HEAD" },
    );
    assert.equal(ticketHead.status, 200);
    const ticketGet = await fetch(
      `${hubServer.url}/api/workspace-file/download?ticket=${encodeURIComponent(ticketJson.ticket)}`,
    );
    assert.equal(ticketGet.status, 200);
    assert.deepEqual(Buffer.from(await ticketGet.arrayBuffer()), largeDownloadBytes);

    // Peer goes offline after ticket was minted -> download re-checks live state and fails with 503
    currentPeer = makePeer(peerServer.url, { state: "offline" });
    const offlineDl = await fetch(
      `${hubServer.url}/api/workspace-file/download?ticket=${encodeURIComponent(ticketJson.ticket)}`,
    );
    assert.equal(offlineDl.status, 503);

    // Back online, then revokeOwner invalidates ticket (401)
    currentPeer = makePeer(peerServer.url, { state: "connected" });
    tickets.revokeOwner("owner-1");
    const revokedDl = await fetch(
      `${hubServer.url}/api/workspace-file/download?ticket=${encodeURIComponent(ticketJson.ticket)}`,
    );
    assert.equal(revokedDl.status, 401);

    // Expired ticket returns 401
    const ticketRes2 = await fetch(`${hubServer.url}/api/workspace-file/download-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: remoteId, path: "notes.md" }),
    });
    const { ticket: expiring } = (await ticketRes2.json()) as { ticket: string };
    now += 60_001;
    const expiredDl = await fetch(
      `${hubServer.url}/api/workspace-file/download?ticket=${encodeURIComponent(expiring)}`,
    );
    assert.equal(expiredDl.status, 401);

    // Local fallback was never called for any remote request
    assert.equal(localFallbackCalls, 1);
  } finally {
    await hubServer.close();
    await peerServer.close();
    await realDsh.close();
    await rm(outer, { recursive: true, force: true });
  }
});

test("Hub rejects invalid, nested, unsubmitted draft, SSH, remote-control, disabled, offline, and legacy Peer identities", async () => {
  // Legacy peer that returns plain 404 (no peer workspace-files header)
  const legacy404Peer = await startHttpServer((_req, res) => {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "Unknown peer endpoint" }));
  });

  const peers = new Map<string, PeerWorkspaceFileEndpoint>([
    ["remote-peer:disabled", makePeer("http://127.0.0.1:9", { enabled: false, state: "disabled" })],
    ["remote-peer:offline", makePeer("http://127.0.0.1:9", { state: "offline" })],
    [
      "remote-peer:legacy-manifest",
      makePeer("http://127.0.0.1:9", {
        manifest: {
          version: "0.25.0",
          platform: "linux",
          hostname: "old",
          epoch: "e1",
          projects: [],
          capabilities: { attachments: 1 },
        },
      }),
    ],
    [
      "remote-peer:no-office",
      makePeer("http://127.0.0.1:9", {
        manifest: {
          version: "0.26.0",
          platform: "linux",
          hostname: "no-office",
          epoch: "e1",
          projects: [],
          capabilities: { workspaceFiles: 1 },
        },
      }),
    ],
    ["remote-peer:stale-404", makePeer(legacy404Peer.url)],
  ]);

  const unsubmittedDraft = "web-remote:draft-unsubmitted";
  const proxy = new RemotePeerWorkspaceFiles({
    resolveDraftCanonicalId: (id) =>
      id === unsubmittedDraft
        ? { isDraft: true, hostId: "remote-peer:peer-1" }
        : { isDraft: false },
    peerClient: (hostId) => peers.get(hostId),
  });

  const hub = await startHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const handled = await proxy.handleApiRequest(
          req,
          Buffer.concat(chunks).toString("utf8"),
          res,
        );
        if (!handled) res.writeHead(500).end("fell through to local");
      })();
    });
  });

  try {
    const invoke = async (scopeId: string, method = "workspaceFiles/stat") => {
      const res = await fetch(`${hub.url}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "check-id",
          method,
          payload: {
            args: { workspaceFileScopeId: scopeId, path: "a.docx", priority: "foreground" },
          },
        }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        rpcId: string;
        result: { ok: boolean; error: { code: string; details?: { reason?: string } } };
      };
    };

    const nestedRemote = remoteSessionId(
      "remote-peer:stale-404",
      remoteSessionId("remote-peer:other", "t1"),
    );

    const cases: Array<[string, string, string, string?]> = [
      [
        unsubmittedDraft,
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "unsubmitted-draft",
      ],
      ["web-remote:draft-expired", "workspaceFiles/stat", "remote/identity-invalid"],
      ["web-remote:!!!not-base64!!!", "workspaceFiles/stat", "remote/identity-invalid"],
      [nestedRemote, "workspaceFiles/stat", "remote/identity-invalid"],
      [
        "remote-control:box-1",
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "host-unsupported",
      ],
      [
        remoteSessionId("remote-control:box-1", "t1"),
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "host-unsupported",
      ],
      [
        remoteSessionId("remote-ssh:box-1", "t1"),
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "host-unsupported",
      ],
      [remoteSessionId("remote-peer:removed", "t1"), "workspaceFiles/stat", "remote/offline"],
      [remoteSessionId("remote-peer:disabled", "t1"), "workspaceFiles/stat", "remote/offline"],
      [remoteSessionId("remote-peer:offline", "t1"), "workspaceFiles/stat", "remote/offline"],
      [
        remoteSessionId("remote-peer:legacy-manifest", "t1"),
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "upgrade-required",
      ],
      [
        remoteSessionId("remote-peer:no-office", "t1"),
        "officeToPdf/render",
        "remote/office-preview-unsupported",
        "upgrade-required",
      ],
      [
        remoteSessionId("remote-peer:stale-404", "t1"),
        "workspaceFiles/stat",
        "remote/workspace-files-unsupported",
        "upgrade-required",
      ],
    ];

    for (const [scopeId, method, expectedCode, expectedReason] of cases) {
      const json = await invoke(scopeId, method);
      assert.equal(json.rpcId, "check-id");
      assert.equal(json.result.ok, false, `Expected failure for ${scopeId}`);
      assert.equal(json.result.error.code, expectedCode, `Wrong code for ${scopeId}`);
      if (expectedReason !== undefined) {
        assert.equal(
          json.result.error.details?.reason,
          expectedReason,
          `Wrong reason for ${scopeId}`,
        );
      }
    }
  } finally {
    await hub.close();
    await legacy404Peer.close();
  }
});

test("Hub uses longer Office render timeout and propagates browser disconnect AbortSignal to Peer", async () => {
  let peerAborted = false;
  let resolvePeerStarted!: () => void;
  const peerStarted = new Promise<void>((resolve) => {
    resolvePeerStarted = resolve;
  });

  const peerServer = await startHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        rpcId: string;
        payload: { args: { path: string } };
      };
      if (parsed.payload.args.path === "slow-success.docx") {
        const timer = setTimeout(() => {
          res.writeHead(200, {
            "content-type": "application/json",
            [PEER_WORKSPACE_FILES_HEADER]: "1",
          });
          res.end(
            JSON.stringify({
              type: "server-response",
              rpcId: parsed.rpcId,
              result: { ok: true, value: { rendered: true } },
            }),
          );
        }, 180);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      if (parsed.payload.args.path === "hang-cancel.docx") {
        resolvePeerStarted();
        res.once("close", () => {
          if (!res.writableEnded) peerAborted = true;
        });
        return;
      }
      // Exceeds officeRenderTimeoutMs
      const timer = setTimeout(() => {
        if (!res.writableEnded) res.writeHead(200).end();
      }, 2_000);
      res.once("close", () => clearTimeout(timer));
    });
  });

  const remoteId = remoteSessionId("remote-peer:peer-1", "t1");
  const proxy = new RemotePeerWorkspaceFiles(
    {
      resolveDraftCanonicalId: () => ({ isDraft: false }),
      peerClient: () => makePeer(peerServer.url),
    },
    { rpcTimeoutMs: 80, officeRenderTimeoutMs: 400 },
  );

  const hub = await startHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void proxy.handleApiRequest(req, Buffer.concat(chunks).toString("utf8"), res);
    });
  });

  try {
    // 1. Slow Office render (180ms > rpcTimeoutMs 80ms, < officeRenderTimeoutMs 400ms) succeeds
    const slowOk = await fetch(`${hub.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "slow-office",
        method: "officeToPdf/render",
        payload: {
          args: {
            workspaceFileScopeId: remoteId,
            path: "slow-success.docx",
            priority: "foreground",
          },
        },
      }),
    });
    const slowJson = (await slowOk.json()) as {
      result: { ok: boolean; value?: { rendered: boolean } };
    };
    assert.equal(slowJson.result.ok, true);
    assert.equal(slowJson.result.value?.rendered, true);

    // 2. Office render exceeding officeRenderTimeoutMs returns remote/timeout
    const timedOut = await fetch(`${hub.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "timeout-office",
        method: "officeToPdf/render",
        payload: {
          args: { workspaceFileScopeId: remoteId, path: "too-slow.docx", priority: "foreground" },
        },
      }),
    });
    const timeoutJson = (await timedOut.json()) as {
      result: { ok: boolean; error: { code: string } };
    };
    assert.equal(timeoutJson.result.ok, false);
    assert.equal(timeoutJson.result.error.code, "remote/timeout");

    // 3. Browser disconnect cancels upstream Peer request
    const abortController = new AbortController();
    const cancelFetch = fetch(`${hub.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        type: "client-request",
        rpcId: "cancel-office",
        method: "officeToPdf/render",
        payload: {
          args: {
            workspaceFileScopeId: remoteId,
            path: "hang-cancel.docx",
            priority: "foreground",
          },
        },
      }),
    }).catch(() => undefined);
    await peerStarted;
    abortController.abort();
    await cancelFetch;
    for (let i = 0; i < 30 && !peerAborted; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(peerAborted, true, "Upstream Peer request should abort when browser disconnects");
  } finally {
    await hub.close();
    await peerServer.close();
  }
});

test("WS workspaceFiles/changes degrades cleanly for remote sessions and leaves local sessions untouched", () => {
  const proxy = new RemotePeerWorkspaceFiles({
    resolveDraftCanonicalId: () => ({ isDraft: false }),
    peerClient: () => undefined,
  });

  const failures: Array<{ code: string; message: string; details?: object }> = [];
  const sink: StreamSink = {
    id: "s1",
    closed: false,
    push() {},
    end() {},
    fail(code, message, details) {
      failures.push({ code, message, details });
    },
    onClose() {},
  };

  // Remote session -> intercepted with workspace-file/watch-unsupported
  assert.equal(
    proxy.handleStream(
      "workspaceFiles/changes",
      { workspaceFileScopeId: remoteSessionId("remote-peer:p1", "t1"), path: "README.md" },
      sink,
    ),
    true,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, "workspace-file/watch-unsupported");
  assert.deepEqual(failures[0]?.details, { path: "README.md" });

  // Local session -> NOT intercepted
  assert.equal(
    proxy.handleStream(
      "workspaceFiles/changes",
      { workspaceFileScopeId: "local-thread", path: "README.md" },
      sink,
    ),
    false,
  );
  assert.equal(failures.length, 1);
});

test("session/openWorkspacePath rejects remote sessions via both ChSessions and RemoteSessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexhost-open-remote-"));
  let openerCalled = 0;
  const events = new EventHub(root);
  const workspaces = new Workspaces(new DataDir(root), root);
  const sessions = new ChSessions(
    new FakeChHost(),
    workspaces,
    events,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      openerCalled += 1;
      return { opened: true };
    },
  );
  const remoteSessions = new RemoteSessions(events, async () => [], workspaces);
  try {
    const rpc = new RpcRegistry();
    const streams = new StreamRegistry();
    sessions.register(rpc, streams);

    // 1. Standalone ChSessions rejects web-remote:* and remote-control:*
    for (const remoteId of [
      remoteSessionId("remote-peer:p1", "t1"),
      "web-remote:draft-1",
      "remote-control:host-1",
    ]) {
      const reply = await rpc.dispatch("session/openWorkspacePath", {
        args: { request: { sessionId: remoteId, path: "/tmp/file.txt" } },
      });
      assert.equal(reply.ok, false);
      if (!reply.ok) assert.equal(reply.error.code, "session/open-unavailable");
    }

    // 2. With RemoteSessions installed, remote openWorkspacePath is also rejected with session/open-unavailable
    remoteSessions.install(rpc, streams);
    const routedReply = await rpc.dispatch("session/openWorkspacePath", {
      args: {
        request: {
          sessionId: remoteSessionId("remote-peer:p1", "t1"),
          path: "/tmp/file.txt",
          action: "reveal",
        },
      },
    });
    assert.equal(routedReply.ok, false);
    if (!routedReply.ok) assert.equal(routedReply.error.code, "session/open-unavailable");

    // 3. Local session still works
    const localReply = await rpc.dispatch("session/openWorkspacePath", {
      args: { request: { sessionId: "local-1", path: "/tmp/file.txt" } },
    });
    assert.deepEqual(localReply, { ok: true, value: { opened: true } });
    assert.equal(openerCalled, 1);

    // 4. peerEndpoint manifest advertises workspaceFiles & officePreview capabilities independently
    const manifest = (await peerEndpoint(
      "GET",
      new URL("http://localhost/api/peer/v1/manifest"),
      {},
      workspaces,
      rpc,
      "epoch-1",
      "0.26.0",
      [root],
      { attachments: true, workspaceFiles: true, officePreview: true },
    )) as {
      capabilities?: { attachments?: number; workspaceFiles?: number; officePreview?: number };
    };
    assert.deepEqual(manifest.capabilities, {
      attachments: 1,
      workspaceFiles: 1,
      officePreview: 1,
    });
  } finally {
    remoteSessions.close();
    sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});
