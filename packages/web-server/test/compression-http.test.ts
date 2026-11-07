/** Exercise the real entry point with fixture assets and an isolated fake Host. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { WebAssets } from "../src/web-assets.ts";
import { CLIENT_PLUGINS } from "../src/plugins.ts";
import { startServer } from "./support/server.ts";

function rawRequest(url: URL, encoding?: string, body?: string) {
  return new Promise<{ headers: IncomingHttpHeaders; body: Buffer; status: number | undefined }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(encoding === undefined ? {} : { "accept-encoding": encoding }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({ headers: res.headers, body: Buffer.concat(chunks), status: res.statusCode }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}

it("compresses send() assets and RPC JSON on the wire without changing cache policy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-compression-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, "../../..");
  const web = join(root, "web");
  mkdirSync(join(root, "app"));
  mkdirSync(join(web, "assets"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
  const script = "console.log('fixture compression');\n".repeat(200);
  writeFileSync(join(web, "index.html"), "<html><head><title>T</title></head><body></body></html>");
  writeFileSync(join(web, "assets/hash.js"), script);
  writeFileSync(join(web, "small.css"), "body{}");
  const plugins = CLIENT_PLUGINS.slice(0, 2).map((id, index) => {
    const dir = String(index);
    mkdirSync(join(web, "plugins", dir), { recursive: true });
    writeFileSync(join(web, "plugins", dir, "client.js"), script);
    return { id, dir, manifest: { platform: "web" } };
  });
  writeFileSync(join(web, "plugins.json"), JSON.stringify(plugins));
  await build({
    entryPoints: [join(repo, "packages/web-server/src/main.ts")],
    outfile: join(root, "app/server.mjs"),
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
  });
  const url = await startServer(t, root, ["--import", "tsx", join(root, "app/server.mjs")], []);
  const assets = new WebAssets({ packedRoot: web, plugins: [], globals: {}, title: "T" });
  const combo = assets.graph.batches[0];
  assert.ok(combo);
  for (const path of ["/", "/extensions", "/assets/hash.js", `/${combo.url}`]) {
    const plain = await rawRequest(new URL(path, url));
    assert.equal(plain.status, 200, path);
    assert.ok(plain.body.length >= 1024, path);
    assert.equal(plain.headers.vary, "Accept-Encoding");
    assert.equal(plain.headers["content-encoding"], undefined);
    const cache = path.startsWith("/assets/") || path.startsWith("/plugins/");
    assert.equal(
      plain.headers["cache-control"],
      cache ? "public, max-age=31536000, immutable" : "no-cache",
    );
    for (const encoding of ["br", "gzip"] as const) {
      const compressed = await rawRequest(new URL(path, url), encoding);
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers["content-encoding"], encoding);
      assert.equal(compressed.headers.vary, "Accept-Encoding");
      assert.equal(compressed.headers["cache-control"], plain.headers["cache-control"]);
      assert.ok(compressed.body.length < plain.body.length);
      assert.deepEqual(
        (encoding === "br" ? brotliDecompressSync : gunzipSync)(compressed.body),
        plain.body,
      );
    }
  }
  const small = await rawRequest(new URL("/small.css", url), "br, gzip");
  assert.equal(small.headers.vary, "Accept-Encoding");
  assert.equal(small.headers["content-encoding"], undefined);
  assert.equal(small.body.toString(), "body{}");

  // An unknown method is handled by RpcRegistry, not the DSH API fallback.
  const body = JSON.stringify({
    type: "client-request",
    rpcId: "compression-http",
    method: `compression/${"missing".repeat(200)}`,
    payload: { args: {} },
  });
  const rpcUrl = new URL("/api/compression/missing", url);
  const plain = await rawRequest(rpcUrl, undefined, body);
  assert.equal(plain.status, 200);
  assert.ok(plain.body.length >= 1024);
  assert.equal(JSON.parse(plain.body.toString()).result.error.code, "gateway/not-found");
  for (const encoding of ["br", "gzip"] as const) {
    const compressed = await rawRequest(rpcUrl, encoding, body);
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers["content-encoding"], encoding);
    assert.equal(compressed.headers.vary, "Accept-Encoding");
    assert.equal(compressed.headers["cache-control"], "no-store");
    assert.deepEqual(
      (encoding === "br" ? brotliDecompressSync : gunzipSync)(compressed.body),
      plain.body,
    );
  }
});
