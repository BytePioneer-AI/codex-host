import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";
import type { Stats } from "node:fs";
import { DshWebServices } from "../src/dsh-web-services.ts";
import {
  PEER_WORKSPACE_FILES_HEADER,
  servePeerWorkspaceFiles,
  validatePeerWorkspacePath,
  type PeerWorkspaceFilesDeps,
  type PeerWorkspaceFsOps,
} from "../src/peer-workspace-files-http.ts";

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
    response.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("Peer workspace-files RPC serves read, stat, list, baseFile readBytes multipart, and download within workspaceRoot", async () => {
  const outer = await mkdtemp(join(tmpdir(), "codexhost-peer-ws-files-"));
  const workspace = join(outer, "workspace");
  const outsideFile = join(outer, "secret.txt");
  const dsh = await DshWebServices.open({
    workspaceRoot: workspace,
    threadWorkspace: (id) => (id === "thread-1" ? workspace : undefined),
    fileWorkspace: (id) => (id === "thread-1" ? workspace : undefined),
  });
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
        dsh,
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
          result: { ok: boolean; value?: { text: string } };
        };
        assert.equal(readJson.rpcId, "rpc-read-1");
        assert.equal(readJson.result.ok, true);
        assert.equal(readJson.result.value?.text, "hello\nworld");

        // 2. workspaceFiles/stat
        const statRes = await rpcCall("rpc-stat-1", "workspaceFiles/stat", {
          workspaceFileScopeId: "thread-1",
          path: "README.md",
        });
        const statJson = (await statRes.json()) as {
          rpcId: string;
          result: { ok: boolean; value?: { bytes: number } };
        };
        assert.equal(statJson.rpcId, "rpc-stat-1");
        assert.equal(statJson.result.ok, true);
        assert.equal(statJson.result.value?.bytes, 12);

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

        // 5. Rejects non-allowlisted / write methods
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

        // 6. Rejects unknown threadId
        const unknownRes = await rpcCall("rpc-unknown", "workspaceFiles/stat", {
          workspaceFileScopeId: "unknown-thread",
          path: "README.md",
        });
        const unknownJson = (await unknownRes.json()) as {
          result: { ok: boolean; error?: { code: string } };
        };
        assert.equal(unknownJson.result.ok, false);
        assert.equal(unknownJson.result.error?.code, "gateway/lookup-not-found");

        // 7. Rejects paths outside workspaceRoot (even though DSH itself would allow them)
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

        // 8. Rejects baseFile traversal & outside baseFile
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

        // 9. Rejects control characters / NUL
        const nulRes = await rpcCall("rpc-nul", "workspaceFiles/stat", {
          workspaceFileScopeId: "thread-1",
          path: "README.md\0.txt",
        });
        assert.equal(
          ((await nulRes.json()) as { result: { error?: { code: string } } }).result.error?.code,
          "gateway/bad-request",
        );

        // 10. Download GET & HEAD with UTF-8 filename + refusal outside workspace
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
    await dsh.close();
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
            async fetchMethod(method, body) {
              officeCalled += 1;
              const parsed = JSON.parse(body) as { rpcId: string };
              return Response.json({
                type: "server-response",
                rpcId: parsed.rpcId,
                result: { ok: true, value: { method } },
              });
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
          assert.equal(officeCalled, 0, "DSH must never be invoked for escaping symlinks");

          // Internal file symlink rejected as not-regular-file across RPC & download
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

          // Download also rejects all symlink escapes with 403 and internal file symlink with 404
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

  // Leading slash before Windows drive letter is accepted
  const okDrive = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "/D:/work/docs/report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(okDrive.ok, true);
  if (okDrive.ok) assert.equal(okDrive.realPath, "D:\\work\\docs\\report.docx");

  // baseFile with leading slash + relative image
  const okBase = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "img.png",
    baseFile: "/D:/work/docs/report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(okBase.ok, true);

  // Cross-drive path rejected
  const crossDrive = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "/C:/Windows/win.ini",
    kind: "file",
    fsOps,
  });
  assert.equal(crossDrive.ok, false);
  if (!crossDrive.ok) assert.equal(crossDrive.code, "workspace-file/outside-workspace");

  // UNC paths rejected
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

  // Drive-relative path rejected
  const driveRelative = await validatePeerWorkspacePath({
    workspaceRoot: "D:\\work",
    path: "D:docs\\report.docx",
    kind: "file",
    fsOps,
  });
  assert.equal(driveRelative.ok, false);
  if (!driveRelative.ok) assert.equal(driveRelative.code, "gateway/bad-request");

  // Sanity: posix pathOps still exported & functional
  assert.equal(posix.join("/a", "b"), "/a/b");
});
