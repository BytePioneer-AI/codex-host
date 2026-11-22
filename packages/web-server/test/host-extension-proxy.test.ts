import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { test, type TestContext } from "node:test";
import {
  HOST_EXTENSION_ASSETS_PREFIX,
  HOST_EXTENSION_MANAGEMENT_METHODS,
  HOST_EXTENSION_UPLOAD_PATH,
  HOST_EXTENSION_ZIP_MAX_BYTES,
  HOST_EXTENSIONS_RPC,
  type ClientChannelEvent,
} from "@codexhost/shared-contracts";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { AccessTokenStore } from "../src/access-tokens.ts";
import { AccessAuth, CredentialConnections, type RequestAuth } from "../src/auth.ts";
import { serveChClientGateway } from "../src/ch-client-gateway.ts";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { isHostExtensionHttpPath, serveHostExtensionHttp } from "../src/host-extension-http.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { DataDir } from "../src/store.ts";

const id = "sample";
const activationId = "bb38c92f-6e43-4dc4-bbed-4a9ab03ebc51";
const digest = "a".repeat(64);
const assetBase = `${HOST_EXTENSION_ASSETS_PREFIX}${id}/${activationId}/${digest}/`;
const uploadPath = HOST_EXTENSION_UPLOAD_PATH;
const zip = makeZip([
  {
    name: "manifest.json",
    data: JSON.stringify({
      manifestVersion: 2,
      id,
      version: "1.0.0",
      name: { en: "Sample", "zh-CN": "示例" },
      description: { en: "Sample plug-in", "zh-CN": "示例插件" },
      web: { apiVersion: 1, entry: "main.mjs" },
    }),
  },
  { name: "main.mjs", data: "export function activate() {}" },
]);
const script = Buffer.from('export const title = "插件";');
const asset = { mimeType: "text/javascript", base64: script.toString("base64"), digest };
const token = "test-local-access-token";
const event: ClientChannelEvent = {
  type: "extensions-changed",
  cursor: { epoch: "host", sequence: 1 },
  revision: 2,
};

async function fixture(
  t: TestContext,
  { noAuth = false, safeMode = false, offline = false, result = {} as unknown } = {},
) {
  const mock = t.mock.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const channel: NonNullable<ChHostClient["realtime"]> = {
    request: mock as NonNullable<ChHostClient["realtime"]>["request"],
    subscribe(listener) {
      listener(event);
      listener({ type: "connection", online: false });
      return () => {};
    },
    snapshot: async () => assert.fail("Unexpected snapshot"),
    respond: async () => assert.fail("Unexpected respond"),
  };
  const host = offline ? {} : { realtime: channel };
  const trust = new RequestTrust(undefined);
  const directory = mkdtempSync(join(tmpdir(), "host-extension-proxy-"));
  const tokens = new AccessTokenStore(new DataDir(directory), { token });
  const access = noAuth ? undefined : new AccessAuth(tokens, trust, new CredentialConnections());
  t.after(() => {
    tokens.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?", 1)[0] ?? "/";
    let requestAuth: RequestAuth | undefined;
    if (access) {
      const admission = await access.gate(req, res, pathname);
      if (admission.handled) return;
      requestAuth = admission.auth;
    }
    if (isHostExtensionHttpPath(pathname)) {
      await serveHostExtensionHttp(host, trust, req, res, pathname, { requestAuth, safeMode });
    } else if (!trust.sameOrigin(req)) {
      res.writeHead(403).end();
    } else {
      await serveChClientGateway(host, req, res, {
        authenticated: requestAuth !== undefined,
        safeMode,
      });
    }
  }).listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${token}`, origin };
  const calls = () => mock.mock.calls.map(({ arguments: args }) => args);
  // Use the raw request path to test that traversal segments are not normalized away by fetch.
  const raw = async (path: string, options: RequestOptions, body?: Iterable<Buffer>) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, ...options, path });
    const reply = once(req, "response");
    for (const part of body ?? []) {
      if (!req.write(part)) await once(req, "drain");
    }
    req.end();
    const [res] = await reply;
    res.resume();
    await finished(res);
    return res.statusCode;
  };
  return { origin, auth, calls, raw };
}

test("GET and HEAD serve the verified activation with an immutable private cache", async (t) => {
  const { origin, auth, calls } = await fixture(t, { result: asset });
  const resource = `${assetBase}assets/panel%20data.mjs`;
  for (const method of ["GET", "HEAD"]) {
    const reply = await fetch(origin + resource, { method, headers: auth });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    assert.equal(reply.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(reply.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(reply.headers.get("content-length"), String(script.length));
    assert.deepEqual(
      Buffer.from(await reply.arrayBuffer()),
      method === "GET" ? script : Buffer.alloc(0),
    );
    assert.deepEqual(calls().at(-1), [
      HOST_EXTENSIONS_RPC.asset,
      { id, activationId, digest, path: "assets/panel data.mjs" },
    ]);
  }
});

test("asset and ZIP routes require authentication, same origin and normal mode", async (t) => {
  for (const [mode, status] of [
    ["signed out", 401],
    ["no-auth", 403],
    ["cross-origin", 403],
    ["safe mode", 403],
    ["Host unavailable", 503],
  ] as const) {
    const { origin, auth, calls } = await fixture(t, {
      noAuth: mode === "no-auth",
      safeMode: mode === "safe mode",
      offline: mode === "Host unavailable",
    });
    const headers =
      mode === "signed out"
        ? { origin }
        : mode === "cross-origin"
          ? { ...auth, origin: "https://other.invalid" }
          : auth;
    for (const [path, init] of [
      [`${assetBase}main.mjs`, { headers }],
      [
        uploadPath,
        { headers: { ...headers, "content-type": "application/zip" }, method: "POST", body: zip },
      ],
    ] as const) {
      const reply = await fetch(origin + path, init);
      assert.equal(reply.status, status, `${mode}: ${path}`);
      assert.equal(
        reply.headers.get("cache-control"),
        status === 401 ? "no-store" : "private, no-store",
      );
    }
    assert.deepEqual(calls(), [], mode);
  }
});

test("rejects bad asset paths before contacting the Host", async (t) => {
  const { raw, auth, calls } = await fixture(t, { result: asset });
  for (const path of [
    ...[
      "../main.mjs",
      "./main.mjs",
      "%2e%2e/main.mjs",
      "%252e%252e/main.mjs",
      "assets%2fmain.mjs",
      "assets%5cmain.mjs",
      "assets//main.mjs",
      "main.mjs/",
      "%bad",
      "",
    ].map((tail) => assetBase + tail),
    `${HOST_EXTENSION_ASSETS_PREFIX}Bad%20ID/${activationId}/${digest}/main.mjs`,
    `${HOST_EXTENSION_ASSETS_PREFIX}${id}/bad/${digest}/main.mjs`,
    `${HOST_EXTENSION_ASSETS_PREFIX}${id}/${activationId}/bad/main.mjs`,
  ])
    assert.equal(await raw(path, { method: "GET", headers: auth }), 400, path);
  assert.deepEqual(calls(), []);
});

test("asset Host refusals and digest mismatches never return bytes or an immutable cache", async (t) => {
  for (const result of [
    new Error("Denied /private/host/extension/backend.mjs"),
    { ...asset, digest: "b".repeat(64) },
  ]) {
    const { origin, auth } = await fixture(t, { result });
    const reply = await fetch(`${origin}${assetBase}backend.mjs`, { headers: auth });
    assert.equal(reply.status, 404);
    assert.equal(reply.headers.get("cache-control"), "private, no-store");
    assert.equal(await reply.text(), "");
  }
});

test("ZIP bytes are forwarded in one install or update RPC", async (t) => {
  const result = { id, digest };
  const { origin, auth, calls } = await fixture(t, { result });
  const source = { type: "zip", base64: zip.toString("base64") };
  const updateQuery = `?id=${id}&expectedDigest=${digest}`;
  for (const [query, expected] of [
    ["", [HOST_EXTENSIONS_RPC.install, { source }]],
    [updateQuery, [HOST_EXTENSIONS_RPC.update, { id, expectedDigest: digest, source }]],
    [
      `${updateQuery}&expectedActivationId=${activationId}`,
      [
        HOST_EXTENSIONS_RPC.update,
        { id, expectedDigest: digest, expectedActivationId: activationId, source },
      ],
    ],
  ] as const) {
    const reply = await fetch(origin + uploadPath + query, {
      headers: { ...auth, "content-type": "application/zip" },
      method: "POST",
      body: zip,
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { result });
    assert.deepEqual(calls().at(-1), expected);
  }
});

test("ZIP proxy rejects unsupported media, partial update parameters and oversized streams", async (t) => {
  const { raw, auth, calls } = await fixture(t);
  const headers = { ...auth, "content-type": "application/zip" };
  assert.equal(
    await raw(uploadPath, { method: "POST", headers: { ...auth, "content-type": "text/plain" } }, [
      zip,
    ]),
    415,
  );
  for (const query of [
    `id=${id}`,
    `expectedDigest=${digest}`,
    `expectedActivationId=${activationId}`,
    `id=${id}&id=${id}&expectedDigest=${digest}`,
  ]) {
    assert.equal(
      await raw(`${uploadPath}?${query}`, { method: "POST", headers }, [zip]),
      400,
      query,
    );
  }
  assert.equal(
    await raw(uploadPath, {
      method: "POST",
      headers: { ...headers, "content-length": HOST_EXTENSION_ZIP_MAX_BYTES + 1 },
    }),
    413,
  );
  function* oversized() {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let size = 0; size < HOST_EXTENSION_ZIP_MAX_BYTES; size += chunk.length) yield chunk;
    yield Buffer.from([0]);
  }
  assert.equal(await raw(uploadPath, { method: "POST", headers }, oversized()), 413);
  assert.deepEqual(calls(), []);
});

test("the client RPC gateway gates all Host extension management methods and otherwise forwards", async (t) => {
  const result = { revision: 1 };
  for (const [mode, status] of [
    ["signed out", 401],
    ["no-auth", 403],
    ["safe mode", 403],
    ["cross-origin", 403],
    ["authenticated", 200],
  ] as const) {
    const { origin, auth, calls } = await fixture(t, {
      noAuth: mode === "no-auth",
      safeMode: mode === "safe mode",
      result,
    });
    const methods =
      mode === "authenticated" ? [HOST_EXTENSIONS_RPC.snapshot] : HOST_EXTENSION_MANAGEMENT_METHODS;
    const headers =
      mode === "signed out"
        ? { origin }
        : mode === "cross-origin"
          ? { ...auth, origin: "https://other.invalid" }
          : auth;
    for (const method of methods) {
      const reply = await fetch(`${origin}/api/ch/v1/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: {} }),
      });
      assert.equal(reply.status, status, `${mode}: ${method}`);
      if (status === 200) {
        assert.deepEqual(await reply.json(), { result });
        assert.deepEqual(calls(), [[method, {}]]);
      } else if (mode === "no-auth" || mode === "safe mode") {
        assert.equal((await reply.json()).error.code, -32000);
      }
    }
    if (mode !== "authenticated") assert.deepEqual(calls(), []);
  }
});

test("forwards extensions-changed events as NDJSON without special handling", async (t) => {
  const { origin, auth } = await fixture(t);
  const reply = await fetch(`${origin}/api/ch/v1/events`, { headers: auth });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("content-type"), "application/x-ndjson");
  assert.deepEqual(JSON.parse(await reply.text()), event);
});
