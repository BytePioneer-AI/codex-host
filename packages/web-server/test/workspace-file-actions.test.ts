import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveResourcesInfo } from "node:process";
import { test } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { downloadWorkspaceFile, openWorkspaceFile } from "../src/workspace-file-actions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

test("a missing Launcher does not leave a timer keeping Node alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "ch-missing-launcher-"));
  const activeTimers = () => getActiveResourcesInfo().filter((type) => type === "Timeout").length;
  try {
    const before = activeTimers();
    await assert.rejects(openWorkspaceFile(join(root, "missing-launcher"), root, "reveal"), {
      code: "session/open-failed",
    });
    assert.equal(activeTimers(), before, "Launcher failure should not leave a referenced timer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads original binary, HTML and empty files with attachment headers; refuses unknown sessions and directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ch-file-actions-"));
  const server = createServer((request, response) => {
    void downloadWorkspaceFile(
      request,
      response,
      new URL(request.url ?? "/", "http://localhost"),
      (id) => (id === "known" ? root : undefined),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    for (const [name, bytes] of [
      ["文档.docx", Buffer.from([0, 255, 1, 128])],
      ["index.html", Buffer.from("<script>alert(1)</script>")],
      ["empty.txt", Buffer.alloc(0)],
    ] as const) {
      await writeFile(join(root, name), bytes);
      const query = new URLSearchParams({ sessionId: "known", path: name });
      const response = await fetch(`${base}/?${query}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      const disposition = response.headers.get("content-disposition") ?? "";
      assert.match(disposition, /^attachment;/u);
      assert.ok(disposition.includes(encodeURIComponent(name)));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await fetch(`${base}/?${query}`, { method: "HEAD" });
      assert.equal(head.headers.get("content-length"), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    for (const query of [
      { sessionId: "unknown", path: "index.html" },
      { sessionId: "known", path: "." },
      { sessionId: "known", path: "missing" },
    ])
      assert.equal((await fetch(`${base}/?${new URLSearchParams(query)}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "workspace path RPC opens files and reveals files or directories through the native launcher",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ch-native-open-"));
    const launcher = join(root, "launcher");
    const workspace = join(root, "workspace");
    const sessions = new ChSessions(
      new FakeChHost(),
      new Workspaces(new DataDir(root), workspace),
      new EventHub(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (path, action) => openWorkspaceFile(launcher, path, action),
    );
    try {
      const sibling = join(root, "sibling worktree");
      const file = join(sibling, "space ; 原文.html");
      const receipt = join(root, "receipt.json");
      await mkdir(workspace);
      await mkdir(sibling);
      await writeFile(file, "original");
      await writeFile(
        launcher,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`,
      );
      await chmod(launcher, 0o700);
      const rpc = new RpcRegistry();
      sessions.register(rpc, new StreamRegistry());
      const openPath = (path: string, action?: string, relay = false) =>
        rpc.dispatch(
          "session/openWorkspacePath",
          { args: { request: { path, action } } },
          undefined,
          undefined,
          relay,
        );
      for (const [action, expectedCommand] of [
        [undefined, "open-file"],
        ["reveal", "reveal-file"],
      ] as const) {
        assert.deepEqual(await openPath(file, action), { ok: true, value: { opened: true } });
        const args = JSON.parse(await readFile(receipt, "utf8"));
        assert.equal(args.length, 2);
        assert.equal(args[0], expectedCommand);
        assert.equal(await readFile(args[1], "utf8"), "original");
      }
      for (const rejected of [
        await openPath(file, "reveal", true),
        await openPath(file, "other"),
      ]) {
        assert.equal(rejected.ok, false);
        if (!rejected.ok) assert.equal(rejected.error.code, "session/open-unavailable");
      }
      assert.deepEqual(await openPath(sibling, "reveal"), { ok: true, value: { opened: true } });
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), [
        "reveal-file",
        await realpath(sibling),
      ]);
      await assert.rejects(openWorkspaceFile(launcher, sibling), /regular files/u);
      await assert.rejects(openWorkspaceFile(launcher, join(root, "missing"), "reveal"), /ENOENT/u);
      await assert.rejects(openWorkspaceFile(launcher, "relative.html"), /absolute/u);
    } finally {
      sessions.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
