import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import webpush from "web-push";
import { PushNotifier } from "../src/push.ts";
import { DataDir } from "../src/store.ts";

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
    for (const name of names) {
      const value = environment[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("push-subscriptions.json", [
    {
      endpoint: "https://push.example.test/device",
      keys: { p256dh: "test-key", auth: "test-auth" },
      createdAt: 1,
    },
  ]);
  return { data, push: new PushNotifier(data) };
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
