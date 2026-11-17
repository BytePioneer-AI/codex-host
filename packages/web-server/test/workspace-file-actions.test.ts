import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadWorkspaceFile, openWorkspaceFile } from "../src/workspace-file-actions.ts";

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
  "desktop handoff passes one canonical file argument to the native launcher",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ch-native-open-"));
    try {
      const launcher = join(root, "launcher");
      const file = join(root, "space ; 原文.html");
      const receipt = join(root, "receipt.json");
      await writeFile(file, "original");
      await writeFile(
        launcher,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`,
      );
      await chmod(launcher, 0o700);
      assert.deepEqual(await openWorkspaceFile(launcher, file), { opened: true });
      const args = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(args[0], "open-file");
      assert.equal(await readFile(args[1], "utf8"), "original");
      await assert.rejects(openWorkspaceFile(launcher, root), /regular files/u);
      await assert.rejects(openWorkspaceFile(launcher, "relative.html"), /absolute/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
