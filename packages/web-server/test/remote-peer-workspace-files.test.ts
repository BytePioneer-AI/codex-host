import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { OfficeToPdfError, type OfficeToPdfResult } from "../src/dsh-web-services.ts";
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
import { WorkspaceFileSearchCache } from "../src/workspace-file-search.ts";
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
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("Hub proxies Typert RPCs, multipart binaries (readBytes & officeToPdf/render), rpcId, errors, and streaming downloads", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-hub-peer-files-"));
  const workspace = join(outer, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "# Hello remote\n");
  await writeFile(join(workspace, "deck.pptx"), Buffer.from("fake-pptx-source"));
  await writeFile(join(workspace, "broken.docx"), "corrupted");
  const largeDownloadBytes = Buffer.alloc(128 * 1024, 0x42);
  await writeFile(join(workspace, "large-report.bin"), largeDownloadBytes);

  const fakePdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const dsh: PeerWorkspaceFilesDsh = {
    async convertOffice(request, signal) {
      const read = await request.source.read(signal, 10 * 1024 * 1024);
      if (Buffer.from(read.bytes).toString("utf8") === "corrupted") {
        throw new OfficeToPdfError("invalid-document", "Corrupted Office document");
      }
      return {
        pdf: fakePdfBytes,
        missingFonts: ["Noto Sans SC"],
        cacheKey: "cache-1" as OfficeToPdfResult["cacheKey"],
        generation: "peer-gen-1" as OfficeToPdfResult["generation"],
      };
    },
  };

  let peerAuthSeen = "";
  const peerServer = await startHttpServer((req, res) => {
    peerAuthSeen = req.headers.authorization ?? "";
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/api/peer/v1/workspace-files/rpc") {
      void servePeerWorkspaceFiles(req, res, "rpc", {
        resolveWorkspaceRoot: (id) => (id === "remote-t1" ? workspace : undefined),
        dsh,
      });
      return;
    }
    if (pathname === "/api/peer/v1/workspace-files/download") {
      void servePeerWorkspaceFiles(req, res, "download", {
        resolveWorkspaceRoot: (id) => (id === "remote-t1" ? workspace : undefined),
        dsh,
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
          req,
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

    // 4. Structured Typert error details preserved for Office failure
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

    assert.equal(localFallbackCalls, 1);
  } finally {
    await hubServer.close();
    await peerServer.close();
    await rm(outer, { recursive: true, force: true });
  }
});

test("Hub rejects invalid, nested, unsubmitted draft, SSH, remote-control, disabled, offline, and legacy Peer identities", async () => {
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

test("Hub enforces JSON size cap, rpcId matching, concurrency limit, stream idle timeout, and HEAD/RPC abort cancellation", async () => {
  let headStarted!: () => void;
  const headStartedPromise = new Promise<void>((r) => {
    headStarted = r;
  });
  let headAborted = false;
  let stallAborted = false;
  let releaseConcurrencySlot!: () => void;
  let slotRequestStarted!: () => void;
  const slotStartedPromise = new Promise<void>((r) => {
    slotRequestStarted = r;
  });

  const peerServer = await startHttpServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname === "/api/peer/v1/workspace-files/download") {
      const target = reqUrl.searchParams.get("path");
      if (req.method === "HEAD" && target === "hang-head.bin") {
        headStarted();
        res.once("close", () => {
          if (!res.writableEnded) headAborted = true;
        });
        return;
      }
      if (req.method === "GET" && target === "stalled-stream.bin") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          [PEER_WORKSPACE_FILES_HEADER]: "1",
        });
        res.write(Buffer.from("first-chunk-"));
        res.once("close", () => {
          if (!res.writableEnded) stallAborted = true;
        });
        return;
      }
      res.writeHead(404, { [PEER_WORKSPACE_FILES_HEADER]: "1" }).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        rpcId: string;
        payload: { args: { path: string } };
      };
      const target = parsed.payload.args.path;
      if (target === "oversized.json") {
        res.writeHead(200, {
          "content-type": "application/json",
          [PEER_WORKSPACE_FILES_HEADER]: "1",
        });
        res.end(
          JSON.stringify({
            type: "server-response",
            rpcId: parsed.rpcId,
            result: { ok: true, value: { text: "x".repeat(4096) } },
          }),
        );
        return;
      }
      if (target === "mismatched-rpc.json") {
        res.writeHead(200, {
          "content-type": "application/json",
          [PEER_WORKSPACE_FILES_HEADER]: "1",
        });
        res.end(
          JSON.stringify({
            type: "server-response",
            rpcId: "someone-elses-rpc-id",
            result: { ok: true, value: {} },
          }),
        );
        return;
      }
      if (target === "hold-slot.txt") {
        slotRequestStarted();
        void new Promise<void>((resolve) => {
          releaseConcurrencySlot = resolve;
        }).then(() => {
          if (!res.writableEnded) {
            res.writeHead(200, {
              "content-type": "application/json",
              [PEER_WORKSPACE_FILES_HEADER]: "1",
            });
            res.end(
              JSON.stringify({
                type: "server-response",
                rpcId: parsed.rpcId,
                result: { ok: true, value: { ok: true } },
              }),
            );
          }
        });
        return;
      }
      if (target === "slow-office.docx") {
        const timer = setTimeout(() => {
          if (!res.writableEnded) {
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
          }
        }, 140);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end();
    });
  });

  const remoteId = remoteSessionId("remote-peer:peer-1", "t1");
  const tickets = new WorkspaceDownloadTickets();
  const proxy = new RemotePeerWorkspaceFiles(
    {
      resolveDraftCanonicalId: () => ({ isDraft: false }),
      peerClient: () => makePeer(peerServer.url),
    },
    {
      rpcTimeoutMs: 70,
      officeRenderTimeoutMs: 350,
      streamIdleTimeoutMs: 120,
      maxJsonResponseBytes: 512,
      maxConcurrentPerPeer: 1,
      maxConcurrentTotal: 2,
    },
  );

  const hub = await startHttpServer((req, res) => {
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
          req,
        );
      });
      return;
    }
    if (reqUrl.pathname === "/api/workspace-file/download") {
      void downloadWorkspaceFile(req, res, reqUrl, () => undefined, undefined, proxy);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void proxy.handleApiRequest(req, Buffer.concat(chunks).toString("utf8"), res);
    });
  });

  try {
    // 1. Oversized JSON response (> 512 bytes) is rejected with remote/response-too-large
    const oversized = await fetch(`${hub.url}/api/workspaceFiles/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "oversize-1",
        method: "workspaceFiles/read",
        payload: { args: { workspaceFileScopeId: remoteId, path: "oversized.json", range: {} } },
      }),
    });
    const oversizedJson = (await oversized.json()) as {
      rpcId: string;
      result: { ok: boolean; error: { code: string } };
    };
    assert.equal(oversizedJson.rpcId, "oversize-1");
    assert.equal(oversizedJson.result.ok, false);
    assert.equal(oversizedJson.result.error.code, "remote/response-too-large");

    // 2. Mismatched rpcId from Peer is rejected rather than silently rewritten
    const mismatched = await fetch(`${hub.url}/api/workspaceFiles/stat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "expected-rpc-id",
        method: "workspaceFiles/stat",
        payload: { args: { workspaceFileScopeId: remoteId, path: "mismatched-rpc.json" } },
      }),
    });
    const mismatchedJson = (await mismatched.json()) as {
      rpcId: string;
      result: { ok: boolean; error: { code: string } };
    };
    assert.equal(mismatchedJson.rpcId, "expected-rpc-id");
    assert.equal(mismatchedJson.result.ok, false);
    assert.equal(mismatchedJson.result.error.code, "remote/request-failed");

    // 3. Office render uses longer officeRenderTimeoutMs (140ms > rpcTimeoutMs 70ms, < 350ms)
    const slowOffice = await fetch(`${hub.url}/api/officeToPdf/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "slow-office-1",
        method: "officeToPdf/render",
        payload: {
          args: {
            workspaceFileScopeId: remoteId,
            path: "slow-office.docx",
            priority: "foreground",
          },
        },
      }),
    });
    const slowOfficeJson = (await slowOffice.json()) as {
      result: { ok: boolean; value?: { rendered: boolean } };
    };
    assert.equal(slowOfficeJson.result.ok, true);
    assert.equal(slowOfficeJson.result.value?.rendered, true);

    // 4. Concurrency cap rejects 2nd simultaneous request with remote/busy & 429, then releases slot
    const firstSlotReq = fetch(`${hub.url}/api/workspaceFiles/stat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "slot-1",
        method: "workspaceFiles/stat",
        payload: { args: { workspaceFileScopeId: remoteId, path: "hold-slot.txt" } },
      }),
    });
    await slotStartedPromise;
    const secondRpc = await fetch(`${hub.url}/api/workspaceFiles/stat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "slot-2",
        method: "workspaceFiles/stat",
        payload: { args: { workspaceFileScopeId: remoteId, path: "any.txt" } },
      }),
    });
    const secondRpcJson = (await secondRpc.json()) as {
      result: { ok: boolean; error: { code: string } };
    };
    assert.equal(secondRpcJson.result.ok, false);
    assert.equal(secondRpcJson.result.error.code, "remote/busy");

    const secondDl = await fetch(
      `${hub.url}/api/workspace-file/download?${new URLSearchParams({ sessionId: remoteId, path: "a.bin" })}`,
    );
    assert.equal(secondDl.status, 429);

    releaseConcurrencySlot();
    const firstSlotRes = await firstSlotReq;
    assert.equal(((await firstSlotRes.json()) as { result: { ok: boolean } }).result.ok, true);

    // 5. Stalled download stream triggers idle timeout and aborts upstream Peer stream
    let stallRejected = false;
    try {
      const stalledRes = await fetch(
        `${hub.url}/api/workspace-file/download?${new URLSearchParams({
          sessionId: remoteId,
          path: "stalled-stream.bin",
        })}`,
      );
      await stalledRes.arrayBuffer();
    } catch {
      stallRejected = true;
    }
    assert.equal(stallRejected, true, "Stalled download stream must terminate on idle timeout");
    for (let i = 0; i < 30 && !stallAborted; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(stallAborted, true, "Upstream Peer stream must be aborted on idle timeout");

    // 6. Browser disconnect during POST /api/workspace-file/download-ticket aborts upstream Peer HEAD
    const headAbort = new AbortController();
    const ticketPromise = fetch(`${hub.url}/api/workspace-file/download-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: headAbort.signal,
      body: JSON.stringify({ sessionId: remoteId, path: "hang-head.bin" }),
    }).catch(() => undefined);
    await headStartedPromise;
    headAbort.abort();
    await ticketPromise;
    for (let i = 0; i < 30 && !headAborted; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(headAborted, true, "Upstream Peer HEAD must abort when ticket caller disconnects");
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

test("session/openWorkspacePath enforces a registered local session and rejects missing, unknown, and remote sessionIds", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexhost-open-remote-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  let openerCalled = 0;
  const host = new FakeChHost();
  host.add("real-local-thread", workspace);
  const events = new EventHub(root);
  const workspaces = new Workspaces(new DataDir(root), workspace);
  const sessions = new ChSessions(
    host,
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

    // Populate real local thread catalog
    const listReply = await rpc.dispatch("session/list", { args: {} });
    assert.equal(listReply.ok, true);

    // 1. Missing, empty, unknown/forged, and remote sessionIds are ALL rejected
    for (const request of [
      { path: "/tmp/file.txt" },
      { sessionId: "", path: "/tmp/file.txt" },
      { sessionId: "unknown-forged-local", path: "/tmp/file.txt" },
      { sessionId: remoteSessionId("remote-peer:p1", "t1"), path: "/tmp/file.txt" },
      { sessionId: "web-remote:draft-1", path: "/tmp/file.txt" },
      { sessionId: "remote-control:host-1", path: "/tmp/file.txt" },
    ]) {
      const reply = await rpc.dispatch("session/openWorkspacePath", {
        args: { request },
      });
      assert.equal(reply.ok, false, `Expected rejection for ${JSON.stringify(request)}`);
      if (!reply.ok) assert.equal(reply.error.code, "session/open-unavailable");
    }
    assert.equal(openerCalled, 0);

    // 2. With RemoteSessions installed, remote openWorkspacePath is also rejected
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

    // 3. Verified registered local thread succeeds
    const localReply = await rpc.dispatch("session/openWorkspacePath", {
      args: { request: { sessionId: "real-local-thread", path: "/tmp/file.txt" } },
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

test("Hub dispatches fileReferences/list end-to-end for remote Peer sessions, bound drafts, legacy 404 degradation, and rejections without falling back to Hub local", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-hub-file-mentions-"));
  const hubWorkspace = join(outer, "hub-local");
  const peerWorkspace = join(outer, "peer-remote");
  const peerSearchCache = new WorkspaceFileSearchCache();
  await mkdir(join(hubWorkspace, "src"), { recursive: true });
  await mkdir(join(peerWorkspace, "src"), { recursive: true });
  await mkdir(join(peerWorkspace, ".git"), { recursive: true });
  await writeFile(join(hubWorkspace, "src", "hub-only.ts"), "hub\n");
  await writeFile(join(peerWorkspace, "src", "remote-only.ts"), "peer\n");
  await writeFile(join(peerWorkspace, "README.md"), "# Peer\n");
  await writeFile(join(peerWorkspace, ".git", "HEAD"), "ref: refs/heads/main\n");

  let peerAuthSeen = "";
  const peerServer = await startHttpServer((req, res) => {
    peerAuthSeen = req.headers.authorization ?? "";
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/api/peer/v1/workspace-files/search") {
      void servePeerWorkspaceFiles(req, res, "search", {
        resolveWorkspaceRoot: (id) => (id === "remote-t1" ? peerWorkspace : undefined),
        searchCache: peerSearchCache,
      });
      return;
    }
    res.writeHead(404).end();
  });

  let legacy404Calls = 0;
  const legacyNoSearchPeer = await startHttpServer((_req, res) => {
    legacy404Calls += 1;
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "Unknown peer endpoint" }));
  });

  const remoteId = remoteSessionId("remote-peer:peer-1", "remote-t1");
  const boundDraftId = "web-remote:draft-bound-search";
  const unsubmittedDraftId = "web-remote:draft-unsubmitted-search";
  const legacyNoSearchId = remoteSessionId("remote-peer:legacy-no-search", "t1");
  let legacyEpoch = "epoch-1";

  const peers = new Map<string, PeerWorkspaceFileEndpoint>([
    ["remote-peer:peer-1", makePeer(peerServer.url)],
    ["remote-peer:offline", makePeer("http://127.0.0.1:9", { state: "offline" })],
    [
      "remote-peer:no-cap",
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
  ]);

  const proxy = new RemotePeerWorkspaceFiles({
    resolveDraftCanonicalId: (sessionId) => {
      if (sessionId === boundDraftId) {
        return { isDraft: true, canonicalId: remoteId, hostId: "remote-peer:peer-1" };
      }
      if (sessionId === unsubmittedDraftId) {
        return { isDraft: true, hostId: "remote-peer:peer-1" };
      }
      return { isDraft: false };
    },
    peerClient: (hostId) => {
      if (hostId === "remote-peer:legacy-no-search") {
        return makePeer(legacyNoSearchPeer.url, {
          manifest: {
            version: "0.26.0",
            platform: "linux",
            hostname: "legacy",
            epoch: legacyEpoch,
            projects: [],
            capabilities: { attachments: 1, workspaceFiles: 1, officePreview: 1 },
          },
        });
      }
      return peers.get(hostId);
    },
  });

  const host = new FakeChHost();
  host.add("local-thread", hubWorkspace);
  const events = new EventHub(outer);
  const workspaces = new Workspaces(new DataDir(outer), hubWorkspace);
  const sessions = new ChSessions(host, workspaces, events);
  const remoteSessions = new RemoteSessions(events, async () => [], workspaces);

  try {
    const rpc = new RpcRegistry();
    const streams = new StreamRegistry();
    sessions.register(rpc, streams);
    remoteSessions.install(rpc, streams);
    sessions.setRemoteFileSearch((sessionId, query, signal) =>
      proxy.searchFiles(sessionId, query, signal),
    );

    // Populate local session catalog so local-thread resolves hubWorkspace
    const listed = await rpc.dispatch("session/list", { args: {} });
    assert.equal(listed.ok, true);

    // 1. Local session keeps searching Hub's local workspace unchanged
    const localReply = await rpc.dispatch("fileReferences/list", {
      args: { agentId: "local-thread", query: "hub-only" },
    });
    assert.deepEqual(localReply, {
      ok: true,
      value: [{ path: "src/hub-only.ts", kind: "file" }],
    });

    // 2. Remote Peer session routes through RemoteSessions.install -> WebFileReferences -> Peer /search
    const remoteReply = await rpc.dispatch("fileReferences/list", {
      args: { agentId: remoteId, query: "remote" },
    });
    assert.equal(peerAuthSeen, "Bearer secret-peer-token");
    assert.deepEqual(remoteReply, {
      ok: true,
      value: [{ path: "src/remote-only.ts", kind: "file" }],
    });

    // Remote Peer must never fall back to Hub's local files
    const noHubLeak = await rpc.dispatch("fileReferences/list", {
      args: { agentId: remoteId, query: "hub-only" },
    });
    assert.deepEqual(noHubLeak, { ok: true, value: [] });

    // 3. Bound remote draft resolves canonicalId and searches the remote Peer workspace
    const boundDraftReply = await rpc.dispatch("fileReferences/list", {
      args: { agentId: boundDraftId, query: "README" },
    });
    assert.deepEqual(boundDraftReply, {
      ok: true,
      value: [{ path: "README.md", kind: "file" }],
    });

    // 4. Legacy Peer with workspaceFiles=1 but no /search route (HTTP 404 without peer header) degrades cleanly to []
    const legacyFirst = await rpc.dispatch("fileReferences/list", {
      args: { agentId: legacyNoSearchId, query: "README" },
    });
    assert.deepEqual(legacyFirst, { ok: true, value: [] });
    assert.equal(legacy404Calls, 1);

    // Cached for the same connection epoch: 2nd search does not hit network again
    const legacySecond = await rpc.dispatch("fileReferences/list", {
      args: { agentId: legacyNoSearchId, query: "app" },
    });
    assert.deepEqual(legacySecond, { ok: true, value: [] });
    assert.equal(legacy404Calls, 1);

    // After Peer reconnects with a new epoch, Hub retries /search
    legacyEpoch = "epoch-2";
    const legacyAfterReconnect = await rpc.dispatch("fileReferences/list", {
      args: { agentId: legacyNoSearchId, query: "app" },
    });
    assert.deepEqual(legacyAfterReconnect, { ok: true, value: [] });
    assert.equal(legacy404Calls, 2);

    // 5. Rejections (unsubmitted draft, offline peer, missing capability, SSH, remote-control) never fall back to Hub
    const rejectionCases: Array<[string, string, string?]> = [
      [unsubmittedDraftId, "remote/workspace-files-unsupported", "unsubmitted-draft"],
      [remoteSessionId("remote-peer:offline", "t1"), "remote/offline"],
      [
        remoteSessionId("remote-peer:no-cap", "t1"),
        "remote/workspace-files-unsupported",
        "upgrade-required",
      ],
      [
        remoteSessionId("remote-ssh:box-1", "t1"),
        "remote/workspace-files-unsupported",
        "host-unsupported",
      ],
      ["remote-control:box-1", "remote/workspace-files-unsupported", "host-unsupported"],
      [
        remoteSessionId("remote-control:box-1", "t1"),
        "remote/workspace-files-unsupported",
        "host-unsupported",
      ],
    ];
    for (const [agentId, expectedCode, expectedReason] of rejectionCases) {
      const reply = await rpc.dispatch("fileReferences/list", {
        args: { agentId, query: "hub-only" },
      });
      assert.equal(reply.ok, false, `Expected rejection for ${agentId}`);
      if (!reply.ok) {
        assert.equal(reply.error.code, expectedCode, `Wrong code for ${agentId}`);
        if (expectedReason !== undefined) {
          assert.equal(
            (reply.error.details as { reason?: string }).reason,
            expectedReason,
            `Wrong reason for ${agentId}`,
          );
        }
      }
    }
  } finally {
    peerSearchCache.close();
    remoteSessions.close();
    sessions.close();
    await peerServer.close();
    await legacyNoSearchPeer.close();
    await rm(outer, { recursive: true, force: true });
  }
});
