import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import webpush from "web-push";
import { PushNotifier } from "../src/push.ts";
import { DataDir } from "../src/store.ts";
import { RpcRegistry } from "../src/transport.ts";

const readyFile = "desktop-shell-ready.json";
const runningShell = {
  pid: process.pid,
  // Windows readiness uses FILETIME microseconds; the Launcher reads the exact u64.
  started_at_micros: 13_438_080_000_000_000,
  executable: process.execPath,
  version: "0.27.0",
};

function proxyEnvironment(t: TestContext, values: NodeJS.ProcessEnv) {
  const names = [
    "NODE_USE_ENV_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const apply = (environment: NodeJS.ProcessEnv) => {
    // Windows environment names are case-insensitive: clear first, then
    // apply the supplied values so deletion of an alias cannot erase a value.
    for (const name of names) Reflect.deleteProperty(process.env, name);
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined) process.env[name] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

function fixture(t: TestContext, endpoints = ["https://push.example.test/device"]) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hostData = new DataDir(root);
  const data = new DataDir(hostData.path("web"));
  data.writeJson(
    "push-subscriptions.json",
    endpoints.map((endpoint) => ({
      endpoint,
      keys: { p256dh: "test-key", auth: "test-auth" },
      createdAt: 1,
    })),
  );
  return { hostData, data, push: new PushNotifier(data) };
}

it("sets a request timeout independently of the notification TTL", async (t) => {
  proxyEnvironment(t, {});
  const { push } = fixture(t);
  const send = t.mock.method(webpush, "sendNotification", async () => {});
  assert.equal(await push.notify({ kind: "test", title: "Test", body: "Body" }), 1);
  assert.equal(send.mock.calls.length, 1);
  assert.deepEqual(send.mock.calls[0]?.arguments[2], {
    TTL: 3600,
    urgency: "high",
    timeout: 10_000,
  });
});

it("sends a push test only to its requesting subscription", async (t) => {
  proxyEnvironment(t, {});
  const target = "https://push.example.test/device";
  const other = "https://push.example.test/other-device";
  const { push } = fixture(t, [target, other]);
  const send = t.mock.method(webpush, "sendNotification", async () => {});
  const rpc = new RpcRegistry();
  push.register(rpc);
  const auth = (credential: string) => ({ credential, local: false, release() {} });
  for (const [endpoint, credential] of [
    [target, "device-a"],
    [other, "device-b"],
  ] as const) {
    assert.equal(
      (
        await rpc.dispatch(
          "codexhost/pushSubscribe",
          { args: { subscription: { endpoint, keys: { p256dh: "p", auth: "a" } } } },
          auth(credential),
        )
      ).ok,
      true,
    );
  }

  const sent = await rpc.dispatch(
    "codexhost/pushTest",
    { args: { endpoint: target } },
    auth("device-a"),
  );
  assert.deepEqual(sent, { ok: true, value: { sent: 1 } });
  assert.deepEqual(
    send.mock.calls.map((call) => call.arguments[0]?.endpoint),
    [target],
  );

  for (const endpoint of [other, "missing"]) {
    assert.deepEqual(
      await rpc.dispatch("codexhost/pushTest", { args: { endpoint } }, auth("device-a")),
      { ok: true, value: { sent: 0 } },
    );
  }
  const invalid = {
    ok: false,
    error: {
      code: "push/invalid-subscription",
      message: "A PushSubscription endpoint is required",
      details: {},
    },
  };
  for (const args of [{}, { endpoint: undefined }, { endpoint: "" }]) {
    assert.deepEqual(await rpc.dispatch("codexhost/pushTest", { args }, auth("device-a")), invalid);
  }
  assert.equal(send.mock.calls.length, 1);
});

it("activates a running shell only for the local owner of the subscription", async (t) => {
  const endpoint = "https://push.example.test/device";
  const { hostData, data, push } = fixture(t);
  const rpc = new RpcRegistry();
  const launcher = hostData.path("codexhost-test");
  const calls: Array<{ executable: string; args: string[]; dataDirectory: string | undefined }> =
    [];
  let accepts = true;
  push.register(rpc, {
    launcher,
    hostDataDirectory: hostData.root,
    launch: async (executable, args, { env }) => {
      calls.push({ executable, args, dataDirectory: env.CODEXHOST_DATA_DIR });
      if (!accepts) throw Object.assign(new Error("Launcher rejected the session"), { code: 1 });
    },
  });
  const auth = { local: true, credential: "local", release() {} };
  const discarded = { ok: true, value: { activated: false } };
  const sessionId = "thread/会话?#";
  const request = {
    args: {
      requestId: randomUUID(),
      endpoint,
      sessionId,
      executable: "untrusted",
      dataDir: "untrusted",
    },
  };
  const method = "codexhost/desktopSessionActivate";
  assert.deepEqual(
    await rpc.dispatch(
      "codexhost/pushSubscribe",
      { args: { subscription: { endpoint, keys: { p256dh: "p", auth: "a" } } } },
      auth,
    ),
    { ok: true, value: { subscribed: true, subscriptions: 1 } },
  );
  const subscriptions = data.readJson<Array<{ endpoint: string; owner: string }>>(
    "push-subscriptions.json",
    [],
  );
  assert.deepEqual(
    subscriptions.map(({ endpoint, owner }) => ({ endpoint, owner })),
    [{ endpoint, owner: "local" }],
  );
  assert.equal(existsSync(hostData.path("push-subscriptions.json")), false);

  const newRequest = () => ({ args: { ...request.args, requestId: randomUUID() } });
  assert.deepEqual(await rpc.dispatch(method, newRequest(), auth), discarded);
  data.writeJson(readyFile, runningShell);
  assert.deepEqual(await rpc.dispatch(method, newRequest(), auth), discarded);
  for (const incomplete of [
    { pid: process.pid },
    { ...runningShell, pid: 0x7fff_ffff },
    { ...runningShell, started_at_micros: undefined },
    { ...runningShell, started_at_micros: 0 },
    { ...runningShell, executable: undefined },
    { ...runningShell, executable: "relative" },
    { ...runningShell, version: undefined },
    { ...runningShell, version: "invalid" },
  ]) {
    hostData.writeJson(readyFile, incomplete);
    assert.deepEqual(await rpc.dispatch(method, newRequest(), auth), discarded);
  }
  const readyPath = hostData.path(readyFile);
  const timestamp = String(runningShell.started_at_micros);
  const readyJson = JSON.stringify(runningShell);
  for (const invalid of ["-1", "9007199254740991.5", "1e3", "18446744073709551616"]) {
    writeFileSync(readyPath, readyJson.replace(timestamp, invalid), "utf8");
    assert.deepEqual(await rpc.dispatch(method, newRequest(), auth), discarded, invalid);
  }
  writeFileSync(readyPath, readyJson.replace(timestamp, "18446744073709551615"), "utf8");
  assert.deepEqual(await rpc.dispatch(method, request), discarded);
  assert.deepEqual(await rpc.dispatch(method, request, { ...auth, local: false }), discarded);
  assert.deepEqual(await rpc.dispatch(method, request, auth, undefined, true), discarded);
  assert.deepEqual(
    await rpc.dispatch(method, request, { ...auth, credential: "other" }),
    discarded,
  );
  assert.deepEqual(
    await rpc.dispatch(method, { args: { ...request.args, endpoint: "missing" } }, auth),
    discarded,
  );
  for (const invalid of [undefined, "", "  ", "thread\u0085id", "会".repeat(342)]) {
    assert.deepEqual(
      await rpc.dispatch(method, { args: { ...request.args, sessionId: invalid } }, auth),
      discarded,
    );
  }
  assert.deepEqual(calls, []);

  assert.deepEqual(await rpc.dispatch(method, request, auth), {
    ok: true,
    value: { activated: true },
  });
  const expected = {
    executable: launcher,
    args: ["app", "--session", sessionId],
    dataDirectory: hostData.root,
  };
  assert.deepEqual(calls, [expected]);
  accepts = false;
  assert.deepEqual(await rpc.dispatch(method, newRequest(), auth), discarded);
  assert.deepEqual(calls, [expected, expected]);
});

it("reconciles a lost HTTP activation response without launching the session again", async (t) => {
  const endpoint = "https://push.example.test/device";
  const otherEndpoint = "https://push.example.test/other";
  const { hostData, push } = fixture(t, [endpoint, otherEndpoint]);
  hostData.writeJson(readyFile, runningShell);
  const rpc = new RpcRegistry();
  const launches: string[] = [];
  const launchStarted = Promise.withResolvers<undefined>();
  const finishLaunch = Promise.withResolvers<undefined>();
  let deliveryUnknown = false;
  push.register(rpc, {
    launcher: hostData.path("codexhost-test"),
    hostDataDirectory: hostData.root,
    launch: async (_launcher, [, , id]) => {
      assert.ok(id);
      launches.push(id);
      launchStarted.resolve(undefined);
      await finishLaunch.promise;
      if (deliveryUnknown)
        throw Object.assign(new Error("Activation outcome unknown"), { code: 2 });
    },
  });
  const auth = (credential: string) => ({ local: true, credential, release() {} });
  async function subscribe(endpoint: string, credential: string) {
    const result = await rpc.dispatch(
      "codexhost/pushSubscribe",
      { args: { subscription: { endpoint, keys: { p256dh: "p", auth: "a" } } } },
      auth(credential),
    );
    assert.equal(result.ok, true);
  }
  await subscribe(endpoint, "first");
  await subscribe(otherEndpoint, "first");
  const args = { endpoint, sessionId: "thread-1", requestId: randomUUID() };
  const accepted = { ok: true, value: { activated: true } };
  const refused = { ok: true, value: { activated: false } };
  async function send(overrides: object = {}, owner = "first") {
    const body = JSON.stringify({
      type: "client-request",
      method: "codexhost/desktopSessionActivate",
      rpcId: randomUUID(),
      payload: { args: { ...args, ...overrides } },
    });
    return JSON.parse(await rpc.handleHttp(body, auth(owner))).result;
  }
  const lostResponse = send();
  await Promise.race([
    launchStarted.promise,
    lostResponse.then(() => assert.fail("Activation did not reach the Launcher")),
  ]);
  const concurrentRetry = send({ retry: true });
  finishLaunch.resolve(undefined);
  // Ignore the first result as if the caller's connection dropped after the request.
  await lostResponse;
  assert.deepEqual(await concurrentRetry, accepted);
  hostData.writeJson(readyFile, null);
  assert.deepEqual(await send({ retry: true }), accepted);
  assert.deepEqual(await send(), accepted);
  assert.deepEqual(await send({ endpoint: otherEndpoint }), refused);
  assert.deepEqual(await send({ sessionId: "different" }), refused);
  await subscribe(endpoint, "other");
  assert.deepEqual(await send({}, "other"), refused);
  hostData.writeJson(readyFile, runningShell);
  assert.deepEqual(await send({ retry: true, requestId: randomUUID() }, "other"), {
    ok: false,
    error: {
      code: "push/activation-unknown",
      message: "Unable to verify the earlier activation",
      details: {},
    },
  });
  assert.deepEqual(launches, [args.sessionId]);

  deliveryUnknown = true;
  const uncertainRequest = { requestId: randomUUID() };
  const unknown = { ok: true, value: { activated: null } };
  assert.deepEqual(await send(uncertainRequest, "other"), unknown);
  assert.deepEqual(await send({ ...uncertainRequest, retry: true }, "other"), unknown);
  assert.deepEqual(launches, [args.sessionId, args.sessionId]);
});

for (const [name, environment, expected] of [
  [
    "enabled",
    { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.example.test:8080" },
    "http://proxy.example.test:8080",
  ],
  ["not enabled", { HTTPS_PROXY: "http://proxy.example.test:8080" }, undefined],
  [
    "disabled",
    { NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "http://proxy.example.test:8080" },
    undefined,
  ],
  [
    "bypassed",
    {
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NO_PROXY: ".example.test",
    },
    undefined,
  ],
] as const) {
  it(`passes the resolved push proxy to web-push on every Node version: ${name}`, async (t) => {
    proxyEnvironment(t, environment);
    const { push } = fixture(t);
    const send = t.mock.method(webpush, "sendNotification", async () => {});
    assert.equal(await push.notify({ kind: "test", title: "Test", body: "Body" }), 1);
    const options = send.mock.calls[0]?.arguments[2];
    assert.equal(options?.proxy, expected);
    assert.equal(options?.timeout, 10_000);
  });
}

it(
  "routes real push delivery through CONNECT without resolving the endpoint locally",
  { timeout: 5_000 },
  async (t) => {
    const requests: string[] = [];
    const server = createServer();
    server.on("connect", (request, socket) => {
      requests.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Test proxy\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    proxyEnvironment(t, {
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
    });
    const { data } = fixture(t);
    const key = createECDH("prime256v1");
    key.generateKeys();
    data.writeJson("push-subscriptions.json", [
      {
        endpoint: "https://push.example.test/device",
        keys: {
          p256dh: key.getPublicKey().toString("base64url"),
          auth: randomBytes(16).toString("base64url"),
        },
        createdAt: 1,
      },
    ]);
    const push = new PushNotifier(data);
    t.mock.method(console, "error", () => {});
    assert.equal(await push.notify({ kind: "test", title: "Test", body: "Body" }), 0);
    assert.deepEqual(requests, ["push.example.test:443"]);
    assert.equal(push.subscriptionCount, 1);
  },
);

it("keeps subscriptions after a timeout so later notifications can succeed", async (t) => {
  const { push } = fixture(t);
  const log = t.mock.method(console, "error", () => {});
  let attempts = 0;
  t.mock.method(webpush, "sendNotification", async () => {
    if (attempts++ === 0) throw new Error("Socket timeout");
  });
  const message = { kind: "turn", title: "Test", body: "Body" } as const;
  assert.equal(await push.notify(message), 0);
  assert.equal(push.subscriptionCount, 1);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(await push.notify(message), 1);
});
