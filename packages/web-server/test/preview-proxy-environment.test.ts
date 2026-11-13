import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { it } from "node:test";
import { promisify } from "node:util";
import { previewLaunch, previewProxyEnvironment } from "../src/preview-launch.ts";

const exec = promisify(execFile);

it("resolves the isolated Web environment through the native Launcher", async () => {
  const parent = {
    PATH: process.env.PATH,
    HTTPS_PROXY: "http://127.0.0.1:12345",
    CODEXHOST_RUNTIME_TOKEN: "must-not-reach-preview",
    NODE_OPTIONS: "--import=/unsafe/hook.mjs",
  };
  const original = { ...parent };
  const launch = previewLaunch("/packed", {}, parent);
  const resolved = await previewProxyEnvironment(
    "/native/launcher",
    launch.env,
    async (...args) => {
      assert.deepEqual(args, ["/native/launcher", ["proxy-environment"], launch.env]);
      assert.equal(args[2].CODEXHOST_RUNTIME_TOKEN, undefined);
      assert.equal(args[2].NODE_OPTIONS, undefined);
      return JSON.stringify({
        HTTPS_PROXY: parent.HTTPS_PROXY,
        https_proxy: parent.HTTPS_PROXY,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "localhost,127.0.0.1,::1",
      });
    },
  );
  assert.equal(resolved.NODE_USE_ENV_PROXY, "1");
  assert.equal(resolved.https_proxy, parent.HTTPS_PROXY);
  assert.equal(resolved.PATH, parent.PATH);
  assert.equal(launch.env.NODE_USE_ENV_PROXY, undefined);
  assert.deepEqual(parent, original);
});

it("uses the native decision unchanged for direct connections and explicit opt-outs", async () => {
  for (const overlay of [{}, { NODE_USE_ENV_PROXY: "0" }]) {
    const parent = { HTTPS_PROXY: "", ...overlay };
    const resolved = await previewProxyEnvironment("/native/launcher", parent, async () =>
      JSON.stringify(overlay),
    );
    assert.deepEqual(resolved, parent);
  }
});

it("does not silently start Web with an unresolved network policy", async () => {
  await assert.rejects(
    previewProxyEnvironment("/native/launcher", {}, async () => {
      throw new Error("Native resolver unavailable");
    }),
    /Native resolver unavailable/u,
  );
});

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const nodeHttpsProxy = (major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24;

it(
  "passes the resolved environment to Node HTTPS without resolving the push hostname locally",
  {
    skip: !nodeHttpsProxy,
  },
  async (t) => {
    const requests: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      requests.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Test proxy\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => proxy.close(() => done())));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    let directConnections = 0;
    const direct = createTcpServer((socket) => {
      directConnections++;
      socket.destroy();
    });
    await new Promise<void>((done) => direct.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => direct.close(() => done())));
    const directAddress = direct.address();
    assert.ok(directAddress && typeof directAddress !== "string");
    const environment = await previewProxyEnvironment("/native/launcher", process.env, async () =>
      JSON.stringify({
        HTTP_PROXY: `http://127.0.0.1:${address.port}`,
        http_proxy: `http://127.0.0.1:${address.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
        https_proxy: `http://127.0.0.1:${address.port}`,
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
        NODE_USE_ENV_PROXY: "1",
      }),
    );
    for (const url of ["https://push.invalid/", `https://127.0.0.1:${directAddress.port}/`]) {
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import https from 'node:https';
    const request = https.get(process.argv[1], { timeout: 2000 });
    request.on('error', () => process.exit(0));
    request.on('timeout', () => request.destroy(new Error('timeout')));
  `,
          url,
        ],
        { env: environment, timeout: 5000 },
      );
    }
    assert.deepEqual(requests, ["push.invalid:443"]);
    assert.equal(directConnections, 1, "NO_PROXY must bypass the proxy for loopback");
  },
);
