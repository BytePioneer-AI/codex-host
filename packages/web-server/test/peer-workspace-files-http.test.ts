import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";
import type { Stats } from "node:fs";
import type { OfficeToPdfResult } from "../src/dsh-web-services.ts";
import {
  MAX_PEER_SEARCH_QUERY_LENGTH,
  PEER_WORKSPACE_FILES_HEADER,
  servePeerWorkspaceFiles,
  validatePeerWorkspacePath,
  type PeerWorkspaceFilesDeps,
  type PeerWorkspaceFsOps,
} from "../src/peer-workspace-files-http.ts";
import { WorkspaceFileSearchCache } from "../src/workspace-file-search.ts";

async function withServer(
  deps: PeerWorkspaceFilesDeps,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/api/peer/v1/workspace-files/rpc") {
      void servePeerWorkspaceFiles(request, response, "rpc", deps);
      return;
    }
    if (pathname === "/api/peer/v1/workspace-files/download") {
      void servePeerWorkspaceFiles(request, response, "download", deps);
      return;
    }
    if (pathname === "/api/peer/v1/workspace-files/search") {
      void servePeerWorkspaceFiles(request, response, "search", deps);
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("Peer workspace-files RPC serves confined read, stat, list, baseFile readBytes multipart, Office convert, and download", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-ws-files-"));
  const workspace = join(outer, "workspace");
  const outsideFile = join(outer, "secret.txt");
  const fakePdf = Buffer.from("%PDF-1.4\nconfined-office\n%%EOF\n");
  let officeInputBytes: Buffer | undefined;

  try {
    await mkdir(join(workspace, "docs", "assets"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "hello\nworld\n");
    await writeFile(
      join(workspace, "docs", "page.html"),
      "<html><img src='assets/logo.bin'></html>",
    );
    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    await writeFile(join(workspace, "docs", "assets", "logo.bin"), binaryBytes);
    await writeFile(join(workspace, "报告.docx"), Buffer.from("PK\x03\x04fake-docx"));
    await writeFile(outsideFile, "top-secret");

    await withServer(
      {
        resolveWorkspaceRoot: (threadId) => (threadId === "thread-1" ? workspace : undefined),
        dsh: {
          async convertOffice(request, signal) {
            const read = await request.source.read(signal, 10 * 1024 * 1024);
            officeInputBytes = Buffer.from(read.bytes);
            return {
              pdf: fakePdf,
              missingFonts: ["PingFang SC"],
              cacheKey: "k1" as OfficeToPdfResult["cacheKey"],
              generation: "peer-gen-1" as OfficeToPdfResult["generation"],
            };
          },
        },
      },
      async (baseUrl) => {
        const rpcCall = (rpcId: string, method: string, args: Record<string, unknown>) =>
          fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "client-request",
              rpcId,
              method,
              payload: { args },
            }),
          });

        // 1. workspaceFiles/read
        const readRes = await rpcCall("rpc-read-1", "workspaceFiles/read", {
          workspaceFileScopeId: "thread-1",
          path: "README.md",
          range: {},
        });
        assert.equal(readRes.status, 200);
        assert.equal(readRes.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");
        const readJson = (await readRes.json()) as {
          type: string;
          rpcId: string;
          result: { ok: boolean; value?: { text: string; lines: number; eof: boolean } };
        };
        assert.equal(readJson.rpcId, "rpc-read-1");
        assert.equal(readJson.result.ok, true);
        assert.equal(readJson.result.value?.text, "hello\nworld");
        assert.equal(readJson.result.value?.lines, 2);
        assert.equal(readJson.result.value?.eof, true);

        // 2. workspaceFiles/stat
        const statRes = await rpcCall("rpc-stat-1", "workspaceFiles/stat", {
          workspaceFileScopeId: "thread-1",
          path: "README.md",
        });
        const statJson = (await statRes.json()) as {
          rpcId: string;
          result: { ok: boolean; value?: { bytes: number; version: string } };
        };
        assert.equal(statJson.rpcId, "rpc-stat-1");
        assert.equal(statJson.result.ok, true);
        assert.equal(statJson.result.value?.bytes, 12);
        assert.ok(statJson.result.value?.version);

        // 3. workspaceFiles/list
        const listRes = await rpcCall("rpc-list-1", "workspaceFiles/list", {
          workspaceFileScopeId: "thread-1",
          path: ".",
        });
        const listJson = (await listRes.json()) as {
          rpcId: string;
          result: { ok: boolean; value?: { entries: Array<{ name: string; type: string }> } };
        };
        assert.equal(listJson.result.ok, true);
        assert.ok(listJson.result.value?.entries.some((e) => e.name === "README.md"));
        assert.ok(
          listJson.result.value?.entries.some((e) => e.name === "docs" && e.type === "directory"),
        );

        // 4. workspaceFiles/readBytes returns real multipart/form-data with binary bytes + metadata rpcId
        const bytesRes = await rpcCall("rpc-bytes-1", "workspaceFiles/readBytes", {
          workspaceFileScopeId: "thread-1",
          path: "assets/logo.bin",
          options: { baseFile: "docs/page.html" },
        });
        assert.equal(bytesRes.status, 200);
        assert.match(bytesRes.headers.get("content-type") ?? "", /^multipart\/form-data;/u);
        const form = await bytesRes.formData();
        const metadata = JSON.parse(String(form.get("metadata"))) as {
          type: string;
          rpcId: string;
          result: { ok: boolean };
          attachments: Array<{ part: string }>;
        };
        assert.equal(metadata.type, "server-response");
        assert.equal(metadata.rpcId, "rpc-bytes-1");
        assert.equal(metadata.result.ok, true);
        const attachment = metadata.attachments[0];
        assert.ok(attachment);
        const part = form.get(attachment.part);
        assert.ok(part instanceof Blob);
        assert.deepEqual(Buffer.from(await part.arrayBuffer()), binaryBytes);

        // 5. officeToPdf/render reads bytes via confined fd reader and returns multipart PDF
        const officeRes = await rpcCall("rpc-office-1", "officeToPdf/render", {
          workspaceFileScopeId: "thread-1",
          path: "报告.docx",
          priority: "foreground",
        });
        assert.equal(officeRes.status, 200);
        assert.match(officeRes.headers.get("content-type") ?? "", /^multipart\/form-data;/u);
        const officeForm = await officeRes.formData();
        const officeMeta = JSON.parse(String(officeForm.get("metadata"))) as {
          rpcId: string;
          result: { ok: boolean; value: { generation: string; missingFonts: string[] } };
          attachments: Array<{ part: string }>;
        };
        assert.equal(officeMeta.rpcId, "rpc-office-1");
        assert.equal(officeMeta.result.ok, true);
        assert.equal(officeMeta.result.value.generation, "peer-gen-1");
        assert.deepEqual(officeMeta.result.value.missingFonts, ["PingFang SC"]);
        assert.deepEqual(officeInputBytes, Buffer.from("PK\x03\x04fake-docx"));
        const pdfAttachment = officeMeta.attachments[0];
        assert.ok(pdfAttachment);
        const pdfPart = officeForm.get(pdfAttachment.part);
        assert.ok(pdfPart instanceof Blob);
        assert.deepEqual(Buffer.from(await pdfPart.arrayBuffer()), fakePdf);

        // 6. Rejects non-allowlisted / write methods
        for (const blocked of ["terminal/shells", "workspaceFiles/changes", "session/prompt"]) {
          const blockedRes = await rpcCall("rpc-blocked", blocked, {
            workspaceFileScopeId: "thread-1",
            path: "README.md",
          });
          const blockedJson = (await blockedRes.json()) as {
            rpcId: string;
            result: { ok: boolean; error?: { code: string } };
          };
          assert.equal(blockedJson.rpcId, "rpc-blocked");
          assert.equal(blockedJson.result.ok, false);
          assert.equal(blockedJson.result.error?.code, "gateway/bad-request");
        }

        // 7. Rejects unknown threadId
        const unknownRes = await rpcCall("rpc-unknown", "workspaceFiles/stat", {
          workspaceFileScopeId: "unknown-thread",
          path: "README.md",
        });
        const unknownJson = (await unknownRes.json()) as {
          result: { ok: boolean; error?: { code: string } };
        };
        assert.equal(unknownJson.result.ok, false);
        assert.equal(unknownJson.result.error?.code, "gateway/lookup-not-found");

        // 8. Rejects paths outside workspaceRoot
        for (const args of [
          { workspaceFileScopeId: "thread-1", path: outsideFile },
          { workspaceFileScopeId: "thread-1", path: "../secret.txt" },
          { workspaceFileScopeId: "thread-1", path: "\\\\server\\share\\file.txt" },
          { workspaceFileScopeId: "thread-1", path: "//server/share/file.txt" },
        ]) {
          const res = await rpcCall("rpc-outside", "workspaceFiles/stat", args);
          const json = (await res.json()) as { result: { ok: boolean; error?: { code: string } } };
          assert.equal(json.result.ok, false);
          assert.equal(json.result.error?.code, "workspace-file/outside-workspace");
        }

        // 9. Rejects baseFile traversal & outside baseFile
        const baseTraversal = await rpcCall("rpc-base-escape", "workspaceFiles/readBytes", {
          workspaceFileScopeId: "thread-1",
          path: "../../secret.txt",
          options: { baseFile: "docs/page.html" },
        });
        assert.equal(
          ((await baseTraversal.json()) as { result: { error?: { code: string } } }).result.error
            ?.code,
          "workspace-file/outside-workspace",
        );

        const outsideBase = await rpcCall("rpc-outside-base", "workspaceFiles/readBytes", {
          workspaceFileScopeId: "thread-1",
          path: "secret.txt",
          options: { baseFile: outsideFile },
        });
        assert.equal(
          ((await outsideBase.json()) as { result: { error?: { code: string } } }).result.error
            ?.code,
          "workspace-file/outside-workspace",
        );

        // 10. Rejects control characters / NUL
        const nulRes = await rpcCall("rpc-nul", "workspaceFiles/stat", {
          workspaceFileScopeId: "thread-1",
          path: "README.md\0.txt",
        });
        assert.equal(
          ((await nulRes.json()) as { result: { error?: { code: string } } }).result.error?.code,
          "gateway/bad-request",
        );

        // 11. Download GET & HEAD with UTF-8 filename + refusal outside workspace
        const dlQuery = new URLSearchParams({ threadId: "thread-1", path: "报告.docx" });
        const headRes = await fetch(
          `${baseUrl}/api/peer/v1/workspace-files/download?${dlQuery.toString()}`,
          { method: "HEAD" },
        );
        assert.equal(headRes.status, 200);
        assert.equal(headRes.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");
        assert.equal(headRes.headers.get("content-length"), "13");
        assert.equal((await headRes.arrayBuffer()).byteLength, 0);

        const getRes = await fetch(
          `${baseUrl}/api/peer/v1/workspace-files/download?${dlQuery.toString()}`,
        );
        assert.equal(getRes.status, 200);
        assert.equal(getRes.headers.get("content-type"), "application/octet-stream");
        assert.ok(
          (getRes.headers.get("content-disposition") ?? "").includes(
            encodeURIComponent("报告.docx"),
          ),
        );
        assert.deepEqual(
          Buffer.from(await getRes.arrayBuffer()),
          Buffer.from("PK\x03\x04fake-docx"),
        );

        const escapeDl = await fetch(
          `${baseUrl}/api/peer/v1/workspace-files/download?${new URLSearchParams({ threadId: "thread-1", path: "../secret.txt" })}`,
        );
        assert.equal(escapeDl.status, 403);
        assert.equal(escapeDl.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");
      },
    );
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test(
  "TOCTOU regression: parent directory swapped to outside symlink between validation and open is rejected across read, readBytes, Office, list, and download",
  { skip: process.platform === "win32" },
  async () => {
    const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-toctou-"));
    const workspace = join(outer, "workspace");
    const outsideDir = join(outer, "outside");
    const subDir = join(workspace, "sub");
    const backupDir = join(outer, "sub-backup");
    await mkdir(subDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(subDir, "doc.docx"), "safe-inside-content");
    await writeFile(join(outsideDir, "doc.docx"), "SECRET-OUTSIDE-CONTENT");

    let officeConvertCalled = 0;
    let swapped = false;
    const resetSubDir = async () => {
      if (!swapped) return;
      await rm(subDir, { force: true });
      await rename(backupDir, subDir);
      swapped = false;
    };

    const fsOps: PeerWorkspaceFsOps = {
      lstat,
      stat,
      open,
      realpath,
      readdir,
      platform: process.platform,
      async beforeOpen() {
        // Deterministically replace workspace/sub with a symlink to outsideDir right after
        // path validation succeeds and right before the actual open/readdir happens.
        if (!swapped) {
          await rename(subDir, backupDir);
          await symlink(outsideDir, subDir);
          swapped = true;
        }
      },
    };

    try {
      await withServer(
        {
          resolveWorkspaceRoot: () => workspace,
          fsOps,
          dsh: {
            async convertOffice(request, signal) {
              officeConvertCalled += 1;
              await request.source.read(signal, 1024 * 1024);
              throw new Error("should not reach convertOffice");
            },
          },
        },
        async (baseUrl) => {
          for (const method of [
            "workspaceFiles/read",
            "workspaceFiles/readBytes",
            "workspaceFiles/stat",
            "officeToPdf/render",
          ] as const) {
            await resetSubDir();
            const res = await fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "client-request",
                rpcId: `toctou-${method}`,
                method,
                payload: {
                  args: {
                    workspaceFileScopeId: "thread-1",
                    path: "sub/doc.docx",
                    ...(method === "workspaceFiles/read" ? { range: {} } : {}),
                    ...(method === "workspaceFiles/readBytes" ? { options: {} } : {}),
                    ...(method === "officeToPdf/render" ? { priority: "foreground" } : {}),
                  },
                },
              }),
            });
            assert.equal(res.status, 200);
            const json = (await res.json()) as {
              result: { ok: boolean; error?: { code: string } };
            };
            assert.equal(json.result.ok, false, `${method} must reject TOCTOU parent swap`);
            assert.equal(
              json.result.error?.code,
              "workspace-file/outside-workspace",
              `${method} returned wrong code`,
            );
          }
          assert.equal(officeConvertCalled, 0, "Office converter must never receive swapped file");

          // workspaceFiles/list also rejects TOCTOU parent swap
          await resetSubDir();
          const listRes = await fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "client-request",
              rpcId: "toctou-list",
              method: "workspaceFiles/list",
              payload: { args: { workspaceFileScopeId: "thread-1", path: "sub" } },
            }),
          });
          const listJson = (await listRes.json()) as {
            result: { ok: boolean; error?: { code: string } };
          };
          assert.equal(listJson.result.ok, false);
          assert.equal(listJson.result.error?.code, "workspace-file/outside-workspace");

          // download also rejects TOCTOU parent swap with 403
          await resetSubDir();
          const dlRes = await fetch(
            `${baseUrl}/api/peer/v1/workspace-files/download?${new URLSearchParams({
              threadId: "thread-1",
              path: "sub/doc.docx",
            })}`,
          );
          assert.equal(dlRes.status, 403);
          assert.ok(!(await dlRes.text()).includes("SECRET-OUTSIDE-CONTENT"));
        },
      );
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  },
);

test("Peer early abort cancels resolveWorkspaceRoot before starting Office conversion and aborts active convertOffice", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-abort-"));
  const workspace = join(outer, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "slides.pptx"), "pptx-bytes");

  let resolveStarted!: () => void;
  const resolveStartedPromise = new Promise<void>((r) => {
    resolveStarted = r;
  });
  let resolveSignalAborted = false;
  let releaseResolve!: () => void;
  let officeStarted = 0;

  try {
    // Case 1: client disconnects while resolveWorkspaceRoot is pending -> Office conversion never starts
    await withServer(
      {
        async resolveWorkspaceRoot(_threadId, signal) {
          resolveStarted();
          signal?.addEventListener(
            "abort",
            () => {
              resolveSignalAborted = true;
              releaseResolve();
            },
            { once: true },
          );
          await new Promise<void>((r) => {
            releaseResolve = r;
          });
          return workspace;
        },
        dsh: {
          async convertOffice() {
            officeStarted += 1;
            throw new Error("must not start after client disconnect");
          },
        },
      },
      async (baseUrl) => {
        const clientAbort = new AbortController();
        const reqPromise = fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: clientAbort.signal,
          body: JSON.stringify({
            type: "client-request",
            rpcId: "abort-before-office",
            method: "officeToPdf/render",
            payload: {
              args: { workspaceFileScopeId: "t1", path: "slides.pptx", priority: "foreground" },
            },
          }),
        }).catch(() => undefined);

        await resolveStartedPromise;
        clientAbort.abort();
        await reqPromise;
        for (let i = 0; i < 30 && !resolveSignalAborted; i += 1) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(resolveSignalAborted, true, "resolveWorkspaceRoot signal must abort early");
        assert.equal(officeStarted, 0, "Office conversion must never start after early abort");
      },
    );

    // Case 2: client disconnects during active convertOffice -> convertOffice signal aborts
    let convertStarted!: () => void;
    const convertStartedPromise = new Promise<void>((r) => {
      convertStarted = r;
    });
    let convertSignalAborted = false;
    await withServer(
      {
        resolveWorkspaceRoot: () => workspace,
        dsh: {
          async convertOffice(_request, signal) {
            convertStarted();
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                convertSignalAborted = true;
                resolve();
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  convertSignalAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
            throw new Error("aborted");
          },
        },
      },
      async (baseUrl) => {
        const clientAbort = new AbortController();
        const reqPromise = fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: clientAbort.signal,
          body: JSON.stringify({
            type: "client-request",
            rpcId: "abort-during-office",
            method: "officeToPdf/render",
            payload: {
              args: { workspaceFileScopeId: "t1", path: "slides.pptx", priority: "foreground" },
            },
          }),
        }).catch(() => undefined);

        await convertStartedPromise;
        clientAbort.abort();
        await reqPromise;
        for (let i = 0; i < 30 && !convertSignalAborted; i += 1) {
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(convertSignalAborted, true, "convertOffice signal must abort on disconnect");
      },
    );
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test(
  "Peer workspace-files enforces symlink escape rejection consistently across preview, Office, and download",
  { skip: process.platform === "win32" },
  async () => {
    const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-symlink-"));
    const workspace = join(outer, "workspace");
    const outsideDir = join(outer, "outside");
    let officeCalled = 0;
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "leak.docx"), "secret-docx");
      await writeFile(join(workspace, "real.txt"), "safe");
      await symlink(join(outsideDir, "leak.docx"), join(workspace, "file-escape.docx"));
      await symlink(outsideDir, join(workspace, "dir-escape"));
      await symlink(join(workspace, "real.txt"), join(workspace, "internal-link.txt"));

      await withServer(
        {
          resolveWorkspaceRoot: (id) => (id === "thread-1" ? workspace : undefined),
          dsh: {
            async convertOffice() {
              officeCalled += 1;
              throw new Error("should not convert");
            },
          },
        },
        async (baseUrl) => {
          for (const method of ["workspaceFiles/stat", "officeToPdf/render"]) {
            for (const target of [
              "file-escape.docx",
              "dir-escape/leak.docx",
              "dir-escape/missing.docx",
            ]) {
              const res = await fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  type: "client-request",
                  rpcId: "sym-1",
                  method,
                  payload: {
                    args: {
                      workspaceFileScopeId: "thread-1",
                      path: target,
                      priority: "foreground",
                    },
                  },
                }),
              });
              const json = (await res.json()) as {
                result: { ok: boolean; error?: { code: string } };
              };
              assert.equal(json.result.ok, false);
              assert.equal(json.result.error?.code, "workspace-file/outside-workspace");
            }
          }
          assert.equal(
            officeCalled,
            0,
            "Office converter must never be invoked for escaping symlinks",
          );

          const internalRpc = await fetch(`${baseUrl}/api/peer/v1/workspace-files/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "client-request",
              rpcId: "sym-internal",
              method: "workspaceFiles/stat",
              payload: { args: { workspaceFileScopeId: "thread-1", path: "internal-link.txt" } },
            }),
          });
          assert.equal(
            ((await internalRpc.json()) as { result: { error?: { code: string } } }).result.error
              ?.code,
            "workspace-file/not-regular-file",
          );

          for (const target of ["file-escape.docx", "dir-escape/leak.docx"]) {
            const dl = await fetch(
              `${baseUrl}/api/peer/v1/workspace-files/download?${new URLSearchParams({ threadId: "thread-1", path: target })}`,
            );
            assert.equal(dl.status, 403);
          }
          const internalDl = await fetch(
            `${baseUrl}/api/peer/v1/workspace-files/download?${new URLSearchParams({ threadId: "thread-1", path: "internal-link.txt" })}`,
          );
          assert.equal(internalDl.status, 404);
        },
      );
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  },
);

test("validatePeerWorkspacePath handles Windows /D:/... drive prefix and rejects UNC and cross-drive paths", async () => {
  const dirs = new Set(["D:\\", "D:\\work", "D:\\work\\docs"]);
  const files = new Set([
    "D:\\work\\docs\\report.docx",
    "D:\\work\\docs\\img.png",
    "C:\\Windows\\win.ini",
  ]);
  const fakeStat = (kind: "dir" | "file"): Stats =>
    ({
      isSymbolicLink: () => false,
      isDirectory: () => kind === "dir",
      isFile: () => kind === "file",
      dev: 1,
      ino: 1,
    }) as unknown as Stats;

  const fsOps: PeerWorkspaceFsOps = {
    platform: "win32",
    async realpath(p) {
      const normalized = win32.resolve(String(p));
      if (dirs.has(normalized) || files.has(normalized)) return normalized;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    async lstat(p) {
      const normalized = win32.resolve(String(p));
      if (dirs.has(normalized)) return fakeStat("dir");
      if (files.has(normalized)) return fakeStat("file");
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    async stat(p) {
      return this.lstat(p);
    },
    async open() {
      throw new Error("unused");
    },
  };

  const okDrive = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "/D:/work/docs/report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(okDrive.ok, true);
  if (okDrive.ok) assert.equal(okDrive.realPath, "D:\\work\\docs\\report.docx");

  const okBase = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "img.png",
    baseFile: "/D:/work/docs/report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(okBase.ok, true);

  const crossDrive = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "/C:/Windows/win.ini",
    kind: "file",
    fsOps,
  });
  assert.equal(crossDrive.ok, false);
  if (!crossDrive.ok) assert.equal(crossDrive.code, "workspace-file/outside-workspace");

  for (const unc of ["\\\\fileserver\\share\\doc.docx", "//fileserver/share/doc.docx"]) {
    const res = await validatePeerWorkspacePath({
      workspaceRoot: "D:\\work",
      path: unc,
      kind: "file",
      fsOps,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "workspace-file/outside-workspace");
  }

  const driveRelative = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "D:docs\\report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(driveRelative.ok, false);
  if (!driveRelative.ok) assert.equal(driveRelative.code, "gateway/bad-request");

  assert.equal(posix.join("/a", "b"), "/a/b");
});

test("Peer workspace-files /search lists matching workspace paths, excludes .git/node_modules, and rejects unknown threads and invalid queries", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-ws-search-"));
  const workspace = join(outer, "workspace");
  const searchCache = new WorkspaceFileSearchCache();
  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Peer Workspace\n");
    await writeFile(join(workspace, "src", "app.ts"), "export const x = 1;\n");
    await writeFile(join(workspace, ".git", "config"), "[core]\n");
    await writeFile(join(workspace, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(join(outer, "outside.txt"), "secret\n");

    await withServer(
      {
        resolveWorkspaceRoot: (threadId) => (threadId === "thread-1" ? workspace : undefined),
        searchCache,
      },
      async (baseUrl) => {
        const search = (params: Record<string, string>) =>
          fetch(
            `${baseUrl}/api/peer/v1/workspace-files/search?${new URLSearchParams(params).toString()}`,
          );

        // 1. Matching workspace file
        const appRes = await search({ threadId: "thread-1", q: "app" });
        assert.equal(appRes.status, 200);
        assert.equal(appRes.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");
        assert.deepEqual(await appRes.json(), {
          items: [{ path: "src/app.ts", kind: "file" }],
        });

        // 2. Empty query lists root entries while excluding .git and node_modules
        const rootRes = await search({ threadId: "thread-1", q: "" });
        assert.equal(rootRes.status, 200);
        const rootJson = (await rootRes.json()) as {
          items: Array<{ path: string; kind: string }>;
        };
        assert.deepEqual(rootJson.items, [
          { path: "src", kind: "directory" },
          { path: "README.md", kind: "file" },
        ]);

        // 3. Excluded directories (.git / node_modules) and traversal are not returned
        for (const q of ["config", "node_modules", "pkg", "../outside"]) {
          const res = await search({ threadId: "thread-1", q });
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), { items: [] });
        }

        // 4. Unknown threadId returns 404 with peer workspace header
        const unknownRes = await search({ threadId: "unknown-thread", q: "app" });
        assert.equal(unknownRes.status, 404);
        assert.equal(unknownRes.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");

        // 5. Missing/nested threadId returns 400
        for (const badThreadId of [
          "",
          "web-remote:abc",
          "remote-control:box-1",
          "remote-peer:p1",
        ]) {
          const res = await search({ threadId: badThreadId, q: "app" });
          assert.equal(res.status, 400);
          assert.equal(res.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");
        }

        // 6. Over-long query and NUL byte query return 400
        const tooLong = await search({
          threadId: "thread-1",
          q: "a".repeat(MAX_PEER_SEARCH_QUERY_LENGTH + 1),
        });
        assert.equal(tooLong.status, 400);
        assert.equal(tooLong.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");

        const nulQuery = await search({ threadId: "thread-1", q: "app\0.ts" });
        assert.equal(nulQuery.status, 400);
        assert.equal(nulQuery.headers.get(PEER_WORKSPACE_FILES_HEADER), "1");

        // 7. Non-GET rejected with 405
        const postRes = await fetch(
          `${baseUrl}/api/peer/v1/workspace-files/search?threadId=thread-1&q=app`,
          { method: "POST" },
        );
        assert.equal(postRes.status, 405);
      },
    );
  } finally {
    searchCache.close();
    await rm(outer, { recursive: true, force: true });
  }
});
