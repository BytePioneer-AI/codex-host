import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as c from "@codexhost/shared-contracts";
import { ChFileInputs } from "../src/ch-file-inputs.ts";
import {
  readVerifiedAttachmentFile,
  servePeerAttachments,
  type PeerAttachmentsDeps,
} from "../src/peer-attachments-http.ts";
import { peerEndpoint } from "../src/peer-manifest.ts";
import { DataDir } from "../src/store.ts";
import { RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { WebFiles } from "../src/web-files.ts";
import { WebImages, WEB_IMAGE_LIMITS } from "../src/web-images.ts";
import { Workspaces } from "../src/workspaces.ts";
import { PNG } from "./support/image.ts";

const PNG_BYTES = Buffer.from(PNG, "base64");

async function startAttachmentServer(deps: PeerAttachmentsDeps) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/peer/v1/uploads") {
      void servePeerAttachments(req, res, "uploads", deps);
      return;
    }
    if (pathname === "/api/peer/v1/prompt") {
      void servePeerAttachments(req, res, "prompt", deps);
      return;
    }
    if (pathname === "/api/peer/v1/file") {
      void servePeerAttachments(req, res, "file", deps);
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

it("advertises attachments capability in manifest only when enabled", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-manifest-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const ws = new Workspaces(data, root, true);
  const rpc = new RpcRegistry();
  ws.register(rpc, new StreamRegistry());

  const defaultManifest = c.remotePeerManifestSchema.parse(
    await peerEndpoint(
      "GET",
      new URL("http://localhost/api/peer/v1/manifest"),
      {},
      ws,
      rpc,
      "epoch-1",
      "1.0.0",
      [root],
    ),
  );
  assert.equal(defaultManifest.capabilities, undefined);

  const disabledManifest = c.remotePeerManifestSchema.parse(
    await peerEndpoint(
      "GET",
      new URL("http://localhost/api/peer/v1/manifest"),
      {},
      ws,
      rpc,
      "epoch-1",
      "1.0.0",
      [root],
      { attachments: false },
    ),
  );
  assert.equal(disabledManifest.capabilities, undefined);

  const enabledManifest = c.remotePeerManifestSchema.parse(
    await peerEndpoint(
      "GET",
      new URL("http://localhost/api/peer/v1/manifest"),
      {},
      ws,
      rpc,
      "epoch-1",
      "1.0.0",
      [root],
      { attachments: true },
    ),
  );
  assert.deepEqual(enabledManifest.capabilities, { attachments: 1 });
});

it("handles uploads, scope binding, prompt dispatch, and validation errors", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-attach-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const images = new WebImages(data);
  const files = new WebFiles(data, images);
  const fileInputs = new ChFileInputs(files, images, async (id) => {
    if (id === "subagent-1") {
      throw new RpcError("subagent/attachment-invalid", "Subagent uploads unavailable.");
    }
    if (id !== "thread-1" && id !== "thread-2") {
      throw new RpcError("session/not-found", "Thread not found.");
    }
    return id;
  });

  const rpc = new RpcRegistry();
  const promptCalls: unknown[] = [];
  rpc.register("session/prompt", async (args) => {
    const request = (args as { request: { sessionId: string; content: unknown[] } }).request;
    const prepared = await fileInputs.prepare(request.sessionId, request.content);
    promptCalls.push({ request, prepared });
    fileInputs.accepted(request.sessionId, request.content);
    return { accepted: true };
  });

  const uploadDelegations: Array<{ id: string; name?: string; imageMediaType?: string }> = [];
  const deps: PeerAttachmentsDeps = {
    sessions: {
      uploadFile: (id, chunks, name, imageMediaType) => {
        uploadDelegations.push({
          id,
          ...(name !== undefined ? { name } : {}),
          ...(imageMediaType !== undefined ? { imageMediaType } : {}),
        });
        return fileInputs.upload(id, chunks, name, imageMediaType);
      },
      localWorkspaceRoot: (id) => (id === "thread-1" ? root : undefined),
    },
    files,
    images,
    rpc,
  };
  const srv = await startAttachmentServer(deps);
  t.after(() => srv.close());

  // 415 for non-octet-stream
  const badContentType = await fetch(`${srv.origin}/api/peer/v1/uploads?threadId=thread-1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hi: 1 }),
  });
  assert.equal(badContentType.status, 415);

  // 405 for non-POST
  const wrongMethod = await fetch(`${srv.origin}/api/peer/v1/uploads?threadId=thread-1`, {
    method: "GET",
  });
  assert.equal(wrongMethod.status, 405);

  // 400 for missing target, conflicting targets, and invalid scope
  const missingTarget = await fetch(`${srv.origin}/api/peer/v1/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: PNG_BYTES,
  });
  assert.equal(missingTarget.status, 400);

  const scope = randomUUID();
  const bothTargets = await fetch(
    `${srv.origin}/api/peer/v1/uploads?threadId=thread-1&scope=${scope}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG_BYTES,
    },
  );
  assert.equal(bothTargets.status, 400);

  const badScope = await fetch(`${srv.origin}/api/peer/v1/uploads?scope=not-a-uuid-v4`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: PNG_BYTES,
  });
  assert.equal(badScope.status, 400);

  // threadId upload delegates to sessions.uploadFile
  const threadUploadRes = await fetch(
    `${srv.origin}/api/peer/v1/uploads?threadId=thread-1&name=shot.png&imageMediaType=image%2Fpng`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: PNG_BYTES,
    },
  );
  assert.equal(threadUploadRes.status, 200);
  const threadUpload = c.remotePeerUploadResultSchema.parse(await threadUploadRes.json());
  assert.equal(threadUpload.ok, true);
  assert.equal(threadUpload.value.file.name, "shot.png");
  assert.equal(threadUpload.value.file.bytes, PNG_BYTES.length);
  assert.deepEqual(uploadDelegations, [
    { id: "thread-1", name: "shot.png", imageMediaType: "image/png" },
  ]);

  // Subagent rejection surfaces in 200 error envelope
  const subagentRes = await fetch(`${srv.origin}/api/peer/v1/uploads?threadId=subagent-1`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: PNG_BYTES,
  });
  assert.equal(subagentRes.status, 200);
  const subagentBody = c.remotePeerUploadResultSchema.parse(await subagentRes.json());
  assert.equal(subagentBody.ok, false);
  assert.equal(subagentBody.error.code, "subagent/attachment-invalid");

  // Scope upload + prompt binding resolves receipt for target thread
  const scopeUploadRes = await fetch(
    `${srv.origin}/api/peer/v1/uploads?scope=${scope}&name=notes.txt`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("hello from scope"),
    },
  );
  assert.equal(scopeUploadRes.status, 200);
  const scopeUpload = c.remotePeerUploadResultSchema.parse(await scopeUploadRes.json());
  assert.equal(scopeUpload.ok, true);

  // Prompt with scope binds receipt to thread-2 and dispatches session/prompt
  const promptRes = await fetch(`${srv.origin}/api/peer/v1/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-2",
      scope,
      requestId: "req-1",
      mode: "queue",
      expectedTurnId: null,
      content: [
        { type: "file", receiptId: scopeUpload.value.receiptId },
        { type: "text", text: "please inspect" },
      ],
    }),
  });
  assert.equal(promptRes.status, 200);
  const promptBody = c.remotePeerPromptResultSchema.parse(await promptRes.json());
  assert.deepEqual(promptBody, { ok: true, value: { accepted: true } });
  assert.equal(promptCalls.length, 1);

  // Cross-session receipt is rejected with FILE_NOT_STAGED inside error envelope
  const wrongSessionPromptRes = await fetch(`${srv.origin}/api/peer/v1/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-2",
      content: [{ type: "file", receiptId: threadUpload.value.receiptId }],
    }),
  });
  assert.equal(wrongSessionPromptRes.status, 200);
  const wrongSessionBody = c.remotePeerPromptResultSchema.parse(await wrongSessionPromptRes.json());
  assert.equal(wrongSessionBody.ok, false);
  assert.equal(wrongSessionBody.error.code, "session/attachment-invalid");
  assert.equal(wrongSessionBody.error.details?.reason, "FILE_NOT_STAGED");

  // Invalid JSON or schema in prompt returns 400
  const invalidPromptJson = await fetch(`${srv.origin}/api/peer/v1/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(invalidPromptJson.status, 400);

  const invalidPromptSchema = await fetch(`${srv.origin}/api/peer/v1/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-1",
      content: [{ type: "image", mediaType: "image/png", data: PNG }],
    }),
  });
  assert.equal(invalidPromptSchema.status, 400);
});

it("serves verified images within workspace or Web storage and blocks escapes, non-images, and oversized files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peer-file-root-"));
  const workspace = join(root, "workspace");
  const outside = mkdtempSync(join(tmpdir(), "peer-file-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(workspace, "sub"), { recursive: true });
  const data = new DataDir(join(root, "data"));
  const images = new WebImages(data);
  const files = new WebFiles(data, images);

  const insidePng = join(workspace, "sub", "diagram.png");
  writeFileSync(insidePng, PNG_BYTES);
  const insideTxt = join(workspace, "sub", "notes.txt");
  writeFileSync(insideTxt, "not an image");
  const insideFakePng = join(workspace, "sub", "fake.png");
  writeFileSync(insideFakePng, "<html><script>alert(1)</script></html>");
  const insideSvg = join(workspace, "sub", "vector.svg");
  writeFileSync(insideSvg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const hugePng = join(workspace, "huge.png");
  writeFileSync(hugePng, PNG_BYTES);
  truncateSync(hugePng, WEB_IMAGE_LIMITS.maxImageBytes + 1);

  const outsidePng = join(outside, "secret.png");
  writeFileSync(outsidePng, PNG_BYTES);

  if (process.platform !== "win32") {
    symlinkSync(outsidePng, join(workspace, "escape-file.png"));
    symlinkSync(outside, join(workspace, "escape-dir"));
  }

  // Upload one image into WebImages and one PNG + one TXT into WebFiles
  const storedImage = images.store(
    // Validate via WebFiles image upload path so we also exercise WebFiles receipt storage
    (await import("../src/web-images.ts")).inspectImage(PNG_BYTES, "image/png"),
  );
  const uploadedFilePng = await files.upload(
    "thread-1",
    (async function* () {
      yield PNG_BYTES;
    })(),
    "uploaded.png",
  );
  const uploadedFilePngPath = join(
    files.directory,
    uploadedFilePng.file.attachmentId.slice("web-file:".length).split("/")[0] ?? "",
    "uploaded.png",
  );
  const uploadedFileTxt = await files.upload(
    "thread-1",
    (async function* () {
      yield Buffer.from("plain text file");
    })(),
    "uploaded.txt",
  );
  const uploadedFileTxtPath = join(
    files.directory,
    uploadedFileTxt.file.attachmentId.slice("web-file:".length).split("/")[0] ?? "",
    "uploaded.txt",
  );

  const deps: PeerAttachmentsDeps = {
    sessions: {
      uploadFile: () => {
        throw new Error("unused");
      },
      localWorkspaceRoot: (id) => {
        if (id === "thread-1") return workspace;
        if (id === "projectless-1") return "";
        return undefined;
      },
    },
    files,
    images,
    rpc: new RpcRegistry(),
  };
  const srv = await startAttachmentServer(deps);
  t.after(() => srv.close());

  // 400 when missing query params
  const missingParams = await fetch(`${srv.origin}/api/peer/v1/file?threadId=thread-1`);
  assert.equal(missingParams.status, 400);

  // 200 for relative path inside workspace (GET + HEAD)
  const relRes = await fetch(
    `${srv.origin}/api/peer/v1/file?${new URLSearchParams({ threadId: "thread-1", path: "sub/diagram.png" })}`,
  );
  assert.equal(relRes.status, 200);
  assert.equal(relRes.headers.get("content-type"), "image/png");
  assert.equal(relRes.headers.get("cache-control"), "private, no-store");
  assert.equal(relRes.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await relRes.arrayBuffer()), PNG_BYTES);

  const headRes = await fetch(
    `${srv.origin}/api/peer/v1/file?${new URLSearchParams({ threadId: "thread-1", path: insidePng })}`,
    { method: "HEAD" },
  );
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get("content-type"), "image/png");
  assert.equal(headRes.headers.get("content-length"), String(PNG_BYTES.length));
  assert.equal((await headRes.arrayBuffer()).byteLength, 0);

  // 200 for WebImages & WebFiles PNG paths (including projectless known thread)
  for (const [threadId, targetPath] of [
    ["thread-1", storedImage],
    ["projectless-1", storedImage],
    ["thread-1", uploadedFilePngPath],
  ] as const) {
    const res = await fetch(
      `${srv.origin}/api/peer/v1/file?${new URLSearchParams({ threadId, path: targetPath })}`,
    );
    assert.equal(res.status, 200, `expected 200 for ${threadId} -> ${targetPath}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_BYTES);
  }

  // 413 for > 50 MiB file without echoing path
  const tooLarge = await fetch(
    `${srv.origin}/api/peer/v1/file?${new URLSearchParams({ threadId: "thread-1", path: hugePng })}`,
  );
  assert.equal(tooLarge.status, 413);
  const tooLargeText = await tooLarge.text();
  assert.equal(tooLargeText.includes("huge.png"), false);
  assert.equal(tooLargeText.includes(workspace), false);

  // 404 cases (never echo path!)
  const forbiddenCases: Array<[string, string]> = [
    ["unknown-thread", insidePng],
    ["unknown-thread", storedImage],
    ["projectless-1", "sub/diagram.png"],
    ["thread-1", outsidePng],
    ["thread-1", join("..", "..", "etc", "passwd")],
    ["thread-1", "sub/missing.png"],
    ["thread-1", insideTxt],
    ["thread-1", insideFakePng],
    ["thread-1", insideSvg],
    ["thread-1", uploadedFileTxtPath],
    ...(process.platform !== "win32"
      ? ([
          ["thread-1", "escape-file.png"],
          ["thread-1", "escape-dir/secret.png"],
        ] as Array<[string, string]>)
      : []),
  ];
  for (const [threadId, targetPath] of forbiddenCases) {
    const res = await fetch(
      `${srv.origin}/api/peer/v1/file?${new URLSearchParams({ threadId, path: targetPath })}`,
    );
    assert.equal(res.status, 404, `expected 404 for ${threadId} -> ${targetPath}`);
    const body = await res.text();
    assert.equal(body.includes(targetPath), false, `response leaked path ${targetPath}`);
    assert.equal(body.includes(outside), false, "response leaked outside root");
    assert.equal(body.includes(workspace), false, "response leaked workspace root");
  }
});

it("blocks parent-directory symlink replacement TOCTOU between realpath and open", async (t) => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "peer-file-toctou-"));
  const workspace = join(root, "workspace");
  const outside = mkdtempSync(join(tmpdir(), "peer-file-toctou-out-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const subDir = join(workspace, "sub");
  mkdirSync(subDir, { recursive: true });
  const insidePng = join(subDir, "diagram.png");
  const outsidePng = join(outside, "diagram.png");
  writeFileSync(insidePng, PNG_BYTES);
  writeFileSync(outsidePng, PNG_BYTES);

  const data = new DataDir(join(root, "data"));
  const images = new WebImages(data);
  const files = new WebFiles(data, images);

  // Swap `workspace/sub` to a symlink pointing outside right before `open` (after `realpath` & `preStat`).
  let swapped = false;
  const result = await readVerifiedAttachmentFile(
    insidePng,
    workspace,
    { files, images },
    {
      lstat,
      stat,
      realpath,
      platform: process.platform,
      open: async (targetPath, flags) => {
        if (!swapped) {
          swapped = true;
          renameSync(subDir, join(workspace, "sub-original"));
          symlinkSync(outside, subDir);
        }
        return open(targetPath, flags);
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result, "missing");

  // Also test swapping before preStat (right after realpath check)
  const subDir2 = join(workspace, "sub2");
  mkdirSync(subDir2, { recursive: true });
  const insidePng2 = join(subDir2, "diagram.png");
  writeFileSync(insidePng2, PNG_BYTES);
  let swappedAfterRealpath = false;
  let realpathCalls = 0;
  const resultAfterRealpath = await readVerifiedAttachmentFile(
    insidePng2,
    workspace,
    { files, images },
    {
      lstat,
      stat,
      open,
      platform: process.platform,
      realpath: async (targetPath) => {
        const resolved = await realpath(targetPath);
        realpathCalls++;
        if (realpathCalls === 2 && !swappedAfterRealpath) {
          swappedAfterRealpath = true;
          renameSync(subDir2, join(workspace, "sub2-original"));
          symlinkSync(outside, subDir2);
        }
        return resolved;
      },
    },
  );
  assert.equal(swappedAfterRealpath, true);
  assert.equal(resultAfterRealpath, "missing");

  // Swapping the workspace root itself to a symlink pointing outside right after realpath must also be rejected.
  const workspaceToSwap = join(root, "workspace-root-swap");
  mkdirSync(workspaceToSwap, { recursive: true });
  const rootInsidePng = join(workspaceToSwap, "diagram.png");
  writeFileSync(rootInsidePng, PNG_BYTES);
  let swappedWorkspaceRoot = false;
  let rootSwapRealpathCalls = 0;
  const resultRootSwap = await readVerifiedAttachmentFile(
    rootInsidePng,
    workspaceToSwap,
    { files, images },
    {
      lstat,
      stat,
      open,
      platform: process.platform,
      realpath: async (targetPath) => {
        const resolved = await realpath(targetPath);
        rootSwapRealpathCalls++;
        if (rootSwapRealpathCalls === 2 && !swappedWorkspaceRoot) {
          swappedWorkspaceRoot = true;
          renameSync(workspaceToSwap, join(root, "workspace-root-swap-original"));
          symlinkSync(outside, workspaceToSwap);
        }
        return resolved;
      },
    },
  );
  assert.equal(swappedWorkspaceRoot, true);
  assert.equal(resultRootSwap, "missing");
});
