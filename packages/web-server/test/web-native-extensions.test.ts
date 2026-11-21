import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readWebNativeExtension } from "@codexhost/harness-plugin-files";
import {
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  WEB_EXTENSION_CATALOG_URL,
  WEB_EXTENSION_RPC_ERRORS as errors,
  WEB_EXTENSION_UPLOAD_PATH,
  WEB_EXTENSIONS_RPC as methods,
  webExtensionsRpcSchemas,
  type WebExtensionsRpcMethod,
  type WebExtensionsRpcResult,
} from "@codexhost/shared-contracts";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import type { RequestAuth } from "../src/auth.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { DataDir } from "../src/store.ts";
import { RpcRegistry } from "../src/transport.ts";
import { registerUiExtensionRpc } from "../src/ui-extension-rpc.ts";
import { WebUiExtensions } from "../src/ui-extensions.ts";
import { registerWebExtensionRpc } from "../src/web-extension-rpc.ts";
import { WebNativeExtensions } from "../src/web-native-extensions.ts";

// The Web package normally runs on node:test. This suite also supports focused Vitest runs.
const test: (name: string, run: () => Promise<void>) => void = process.env.VITEST
  ? (await import("vitest")).test
  : (await import("node:test")).test;
const identity = { format: "codexhost", id: "sample" } as const;
const owner: RequestAuth = { credential: "owner", local: false, release() {} };
const stranger: RequestAuth = { ...owner, credential: "other" };
const backend = `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function activate(ctx) {
  await ctx.readSettings();
  ctx.handle('pid', () => process.pid);
  ctx.handle('read', () => ctx.readSettings());
  ctx.handle('write', (values) => ctx.writeSettings(values));
  ctx.handle('failure', () => { throw new Error(ctx.extensionDir); });
  return async () => {
    try { await ctx.writeSettings({ fromDisposer: true }); }
    catch { await writeFile(join(ctx.dataDir, 'disposed'), String(process.pid)); }
  };
}`;

function zip(version: string, id = identity.id as string, script = backend) {
  return makeZip([
    {
      name: "manifest.json",
      data: JSON.stringify({
        manifestVersion: 2,
        id,
        version,
        name: "Sample",
        web: { apiVersion: 1, entry: "main.mjs" },
        backend: { apiVersion: 1, entry: "assets/backend.mjs" },
      }),
    },
    { name: "main.mjs", data: `export const version = ${JSON.stringify(version)};` },
    { name: "assets/backend.mjs", data: script },
    { name: "assets/panel data.json", data: "{}" },
    { name: "assets/not-public.html", data: "<h1>private</h1>" },
    { name: "assets/not-public.svg", data: "<svg/>" },
    { name: "settings.json", data: '{"secret":true}' },
  ]);
}

async function fixture(
  options: {
    permitted?: boolean;
    data?: DataDir;
    download?: Parameters<typeof registerWebExtensionRpc>[4];
  } = {},
) {
  const data = options.data ?? new DataDir(await mkdtemp(join(tmpdir(), "web-native-test-")));
  const native = new WebNativeExtensions(data, options.permitted ?? true);
  const rpc = new RpcRegistry();
  const dsh = new WebUiExtensions(data, {
    validate() {},
    apply: async (plugins) => ({ loadedIds: plugins.map(({ id }) => id), loadErrors: {} }),
    installPackage: async (directory) => {
      const packageDir = join(directory, "node_modules", identity.id);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { sample: "1" } }),
      );
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "sample", version: "1" }),
      );
    },
  });
  registerUiExtensionRpc(rpc, dsh);
  const trust = new RequestTrust(undefined);
  const http = registerWebExtensionRpc(rpc, native, dsh, trust, options.download);
  const server = createServer(async (req, res) => {
    const auth =
      req.headers.authorization === owner.credential
        ? owner
        : req.headers.authorization === stranger.credential
          ? stranger
          : undefined;
    if (!(await http.serve(req, res, req.url ?? "/", auth))) res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  await native.start();
  return {
    data,
    native,
    rpc,
    origin,
    async close() {
      await Promise.all([
        native.stop(),
        http.close(),
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      if (!options.data) await rm(data.root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const dispatch = (
  f: Fixture,
  method: string,
  args: object = {},
  auth: RequestAuth | null = owner,
) => f.rpc.dispatch(method, { args }, auth ?? undefined);
async function call<M extends WebExtensionsRpcMethod>(f: Fixture, method: M, args: object = {}) {
  const reply = await dispatch(f, method, args);
  assert(reply.ok, JSON.stringify(reply));
  return webExtensionsRpcSchemas[method].result.parse(reply.value) as WebExtensionsRpcResult<M>;
}

async function upload(f: Fixture, chunks: Iterable<Buffer>, headers: Record<string, string> = {}) {
  const req = request(f.origin + WEB_EXTENSION_UPLOAD_PATH, {
    method: "POST",
    headers: {
      origin: f.origin,
      authorization: owner.credential,
      "content-type": "application/zip",
      ...headers,
    },
  });
  const response = once(req, "response").then(async ([res]) => {
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    return { status: res.statusCode, text: Buffer.concat(chunks).toString() };
  });
  let finalChunk: Buffer | undefined;
  for (const chunk of chunks) {
    if (finalChunk && !req.write(finalChunk)) await once(req, "drain");
    finalChunk = chunk;
  }
  req.end(finalChunk);
  return response;
}

async function source(f: Fixture, bytes: Buffer) {
  const response = await upload(f, [bytes.subarray(0, 8), bytes.subarray(8)]);
  assert.equal(response.status, 200);
  return { type: "zip", uploadId: JSON.parse(response.text).uploadId };
}

async function active(f: Fixture, hasBackend = true) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const entry = (await call(f, methods.snapshot)).extensions[0];
    if (entry && entry.hasBackend === hasBackend) return entry;
    await delay(20);
  }
  assert.fail("Extension did not reach the expected runtime state");
}

const code = async (reply: ReturnType<typeof dispatch>) => {
  const result = await reply;
  assert(!result.ok);
  return result.error.code;
};
const assertExited = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

test("streams bounded ZIP uploads and binds a single use to the authenticated credential", async () => {
  const f = await fixture();
  try {
    assert.equal((await upload(f, [], { origin: "https://foreign.example" })).status, 403);
    assert.equal((await upload(f, [], { authorization: "" })).status, 403);
    assert.equal((await upload(f, [], { "content-type": "application/json" })).status, 415);
    assert.equal(
      (await upload(f, [], { "content-length": String(DESKTOP_EXTENSION_ZIP_MAX_BYTES + 1) }))
        .status,
      413,
    );
    const chunk = Buffer.alloc(1024 * 1024);
    function* oversized() {
      for (
        let remaining = DESKTOP_EXTENSION_ZIP_MAX_BYTES;
        remaining > 0;
        remaining -= chunk.length
      )
        yield chunk.subarray(0, remaining);
      yield Buffer.alloc(1);
    }
    assert.equal((await upload(f, oversized())).status, 413);
    const install = { format: identity.format, source: await source(f, zip("1")) };
    assert.equal(await code(dispatch(f, methods.install, install, stranger)), errors.notFound);
    const installed = await call(f, methods.install, install);
    assert.equal(installed.extensions[0]?.format, "codexhost");
    assert.equal(await code(dispatch(f, methods.install, install)), errors.notFound);
    assert.equal(await code(dispatch(f, methods.list, { extra: true })), errors.invalidParams);
  } finally {
    await f.close();
  }
});

test("updates in place, retires old assets and settings calls, and reaps an independent backend on shutdown", async () => {
  const f = await fixture();
  try {
    const installed = await call(f, methods.install, {
      format: identity.format,
      source: await source(f, zip("1")),
    });
    assert.match(JSON.stringify(installed), /"enabled":false/);
    const empty = await call(f, methods.settingsGet, { id: identity.id });
    assert.deepEqual(empty.values, {});
    const written = await call(f, methods.settingsSet, {
      id: identity.id,
      values: { theme: "dark" },
    });
    assert.notEqual(empty.revision, written.revision);
    assert.equal(
      await code(
        dispatch(f, methods.settingsSet, {
          id: identity.id,
          values: { tooLarge: "x".repeat(1024 * 1024) },
        }),
      ),
      errors.changeFailed,
    );
    await call(f, methods.setEnabled, { ...identity, enabled: true });
    const first = await active(f);
    const old = { id: first.id, activationId: first.activationId };
    const invoke = (binding: typeof old, method: string, params?: object) =>
      call(f, methods.backendInvoke, { ...binding, method, ...(params ? { params } : {}) });
    const pid = (await invoke(old, "pid")).result;
    assert(typeof pid === "number" && pid !== process.pid);
    assert.deepEqual((await invoke(old, "read")).result, written.values);
    const beforeWrite = await call(f, methods.snapshot);
    assert.deepEqual((await invoke(old, "write", { compact: true })).result, { compact: true });
    assert.notEqual((await call(f, methods.snapshot)).revision, beforeWrite.revision);
    const settings = await call(f, methods.settingsGet, old);
    assert.deepEqual(settings.values, { compact: true });
    assert.equal((await active(f)).settingsRevision, settings.revision);
    assert.equal((await active(f)).activationId, first.activationId);
    const failed = await dispatch(f, methods.backendInvoke, { ...old, method: "failure" });
    assert(!failed.ok && failed.error.code === errors.backendFailed);
    assert(!failed.error.message.includes(f.data.root));

    const get = (path: string, options?: RequestInit) =>
      fetch(f.origin + path, {
        ...options,
        headers: { authorization: owner.credential, ...options?.headers },
      });
    assert(first.entryUrl);
    let response = await get(first.entryUrl, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "");
    assert.equal(
      (await get(first.entryUrl, { headers: { origin: "https://foreign.example" } })).status,
      403,
    );
    assert.equal((await get(first.entryUrl, { headers: { authorization: "" } })).status, 403);
    response = await get(first.assetBaseUrl + "assets/panel%20data.json");
    assert.equal(await response.text(), "{}");
    for (const file of [
      "assets/backend.mjs",
      "assets/not-public.html",
      "assets/not-public.svg",
      "settings.json",
      "%6dain.mjs",
    ]) {
      assert.equal((await get(first.assetBaseUrl + file)).status, 404, file);
    }

    assert.equal(
      await code(
        dispatch(f, methods.update, {
          ...identity,
          expectedDigest: "f".repeat(64),
          source: await source(f, zip("2")),
        }),
      ),
      errors.stale,
    );
    assert.equal(
      await code(
        dispatch(f, methods.update, {
          ...identity,
          expectedDigest: first.digest,
          source: await source(f, zip("2", "different")),
        }),
      ),
      errors.invalidParams,
    );
    assert.equal((await active(f)).activationId, first.activationId);
    await call(f, methods.update, {
      ...identity,
      expectedDigest: first.digest,
      source: await source(f, zip("2")),
    });
    assertExited(pid);
    const second = await active(f);
    assert.equal(second.version, "2");
    assert.notEqual(second.activationId, first.activationId);
    assert.notEqual(second.digest, first.digest);
    assert.equal(second.settingsRevision, settings.revision);
    assert.equal((await get(first.entryUrl)).status, 404);
    assert.equal(
      await code(dispatch(f, methods.settingsSet, { ...old, values: {} })),
      errors.inactive,
    );
    assert.equal(
      await code(dispatch(f, methods.backendInvoke, { ...old, method: "pid" })),
      errors.inactive,
    );
    const secondPid = (await invoke({ id: second.id, activationId: second.activationId }, "pid"))
      .result;
    assert(typeof secondPid === "number");
    const stopping = f.native.stop();
    assert.equal(f.native.stop(), stopping);
    assert.deepEqual((await call(f, methods.snapshot)).extensions, []);
    await stopping;
    assertExited(secondPid);
    assert.equal(
      await readFile(f.data.path("web-native-extension-data", identity.id, "disposed"), "utf8"),
      String(secondPid),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          f.data.path("web-native-extension-data", identity.id, "settings.json"),
          "utf8",
        ),
      ),
      settings.values,
    );
  } finally {
    await f.close();
  }
});

test("restores saved selection, keeps UI available on backend failure, and recovers a broken package", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-native-restart-"));
  const data = new DataDir(root);
  try {
    const initial = await fixture({ data });
    try {
      await call(initial, methods.install, {
        format: identity.format,
        source: await source(initial, zip("1", identity.id, "throw new Error('private')")),
      });
      await call(initial, methods.setEnabled, { ...identity, enabled: true });
      await active(initial, false);
    } finally {
      await initial.close();
    }
    const disabled = await fixture({ data, permitted: false });
    try {
      assert.deepEqual((await call(disabled, methods.snapshot)).extensions, []);
      assert.equal(
        await code(dispatch(disabled, methods.setEnabled, { ...identity, enabled: false })),
        errors.authDisabled,
      );
    } finally {
      await disabled.close();
    }
    const fresh = await fixture({ data });
    try {
      assert((await active(fresh, false)).entryUrl);
      assert.deepEqual(await dispatch(fresh, methods.snapshot, {}, null), {
        ok: true,
        value: fresh.native.snapshot(false),
      });
      const installed = await readWebNativeExtension({ dataDir: root, id: identity.id });
      assert(installed);
      await rm(join(installed.directory, "manifest.json"));
      const [broken] = (await call(fresh, methods.list)).extensions;
      assert(broken?.format === "codexhost" && broken.enabled && !broken.manifest && broken.error);
      await call(fresh, methods.setEnabled, { ...identity, enabled: false });
      assert.deepEqual((await call(fresh, methods.snapshot)).extensions, []);
      assert.deepEqual((await call(fresh, methods.uninstall, identity)).extensions, []);
    } finally {
      await fresh.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the v2 mirror and last good market catalog, binds ZIP digest, and preserves both DSH RPC surfaces", async () => {
  const archive = zip("2");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const downloadUrl = "https://github.com/owner/repo/releases/download/v2/sample.zip";
  const entry = {
    ...identity,
    version: "2",
    sha256,
    downloadUrl,
    name: { en: "Sample", "zh-CN": "示例" },
    description: { en: "Sample", "zh-CN": "示例" },
    author: "author",
    repository: "https://github.com/owner/repo",
    targets: ["web"],
    apis: { web: 1, backend: 1 },
  };
  let mirrorOnline = false;
  let zipBytes = zip("1");
  const f = await fixture({
    download: async (url) => {
      if (url === WEB_EXTENSION_CATALOG_URL) throw new Error("primary unavailable");
      if (url.includes("cdn.jsdelivr.net") && mirrorOnline)
        return Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-01-01",
            extensions: [
              entry,
              entry,
              { ...entry, id: "desktop", targets: ["desktop"], apis: { desktop: 1 } },
            ],
          }),
        );
      if (url === "https://api.github.com/repos/owner/repo/releases/latest")
        return Buffer.from(
          JSON.stringify({ assets: [{ name: "sample.zip", browser_download_url: downloadUrl }] }),
        );
      if (url === downloadUrl) return zipBytes;
      throw new Error("not available");
    },
  });
  try {
    assert.equal(await code(dispatch(f, methods.marketRefresh)), errors.marketUnavailable);
    mirrorOnline = true;
    const market = await call(f, methods.marketRefresh);
    assert.equal(market.stale, false);
    assert.equal(market.skippedCount, 1);
    assert.deepEqual(
      market.extensions.map(({ id }) => id),
      [identity.id],
    );
    mirrorOnline = false;
    assert.deepEqual((await call(f, methods.marketRefresh)).extensions, market.extensions);
    assert.equal((await call(f, methods.marketRefresh)).stale, true);
    const install = {
      format: identity.format,
      source: { type: "market", id: identity.id, version: "2", sha256 },
    };
    assert.equal(await code(dispatch(f, methods.install, install)), errors.changeFailed);
    zipBytes = archive;
    await call(f, methods.install, install);
    const mixed = await call(f, methods.install, { format: "dsh", source: { spec: "sample" } });
    assert.deepEqual(
      mixed.extensions.map(({ format, id }) => [format, id]),
      [
        ["dsh", "sample"],
        ["codexhost", "sample"],
      ],
    );
    const dsh = { format: "dsh", id: identity.id };
    assert.deepEqual((await call(f, methods.setEnabled, { ...dsh, enabled: true })).dshLoadedIds, [
      identity.id,
    ]);
    const legacy = await dispatch(f, "codexhost/uiExtensions/list");
    assert(legacy.ok);
    assert.deepEqual(
      await code(dispatch(f, "codexhost/uiExtensions/list", {}, null)),
      errors.authDisabled,
    );
    await call(f, methods.uninstall, dsh);
    await call(f, methods.uninstall, identity);
    assert.equal(
      await code(
        dispatch(f, methods.install, {
          format: identity.format,
          source: { type: "github", repository: "owner/repo", asset: "other.zip" },
        }),
      ),
      errors.notFound,
    );
    assert.equal(
      (
        await call(f, methods.install, {
          format: identity.format,
          source: { type: "github", repository: "owner/repo", asset: "sample.zip" },
        })
      ).extensions.length,
      1,
    );
  } finally {
    await f.close();
  }
});
