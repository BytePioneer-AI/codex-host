/** Token storage shared by several Web processes, and what a request may claim about itself. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";

import { AccessTokenStore } from "../src/access-tokens.ts";
import { CredentialConnections, FailedSignInLimit } from "../src/auth.ts";
import { PushNotifier } from "../src/push.ts";
import { isLocalConnection, RequestTrust } from "../src/request-trust.ts";
import { DataDir } from "../src/store.ts";
import { RpcRegistry } from "../src/transport.ts";

function dataDir(t: TestContext): DataDir {
  const root = mkdtempSync(join(tmpdir(), "codexhost-access-tokens-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new DataDir(root);
}

function store(t: TestContext, data: DataDir, options: { token?: string } = {}): AccessTokenStore {
  const tokens = new AccessTokenStore(data, options);
  t.after(() => tokens.close());
  return tokens;
}

function request(
  headers: Record<string, string>,
  socket: { remoteAddress?: string; localPort?: number } = {},
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1", localPort: 4400, ...socket },
  } as unknown as IncomingMessage;
}

it("keeps named tokens available to view after reopening the store", (t) => {
  const data = dataDir(t);
  const tokens = store(t, data);
  const { secret, token } = tokens.create("  我的手机  ");
  assert.equal(token.name, "我的手机");
  assert.equal(token.lastUsedAt, null);
  assert.equal(Buffer.from(secret, "base64url").length, 32);
  assert.equal(tokens.resolve(secret), token.id);
  assert.equal(tokens.resolve("not-a-token"), undefined);
  assert.equal(token.secret, secret);
  assert.equal(tokens.list()[0]?.secret, secret);
  assert.equal(store(t, data).list()[0]?.secret, secret);
  if (process.platform !== "win32") {
    assert.equal(statSync(data.path("access-tokens.json")).mode & 0o777, 0o600);
    assert.equal(statSync(data.path("auth.json")).mode & 0o777, 0o600);
  }
});

it("keeps hash-only tokens usable without claiming their plaintext is available", (t) => {
  const data = dataDir(t);
  const tokens = store(t, data);
  const { secret, token } = tokens.create("existing");
  const saved = data.readJson<{ tokens: Array<{ secret?: string }> }>("access-tokens.json", {
    tokens: [],
  });
  for (const entry of saved.tokens) delete entry.secret;
  data.writeJson("access-tokens.json", saved);

  const reopened = store(t, data);
  assert.equal(reopened.resolve(secret), token.id);
  assert.equal(reopened.list()[0]?.secret, null);
  reopened.create("new");
  assert.equal(reopened.resolve(secret), token.id);
});

it("rejects empty, too long, and duplicate names without creating a token", (t) => {
  const tokens = store(t, dataDir(t));
  tokens.create("phone");
  for (const [name, code] of [
    ["   ", "auth/invalid-token-name"],
    ["x".repeat(65), "auth/invalid-token-name"],
    [" phone ", "auth/duplicate-token-name"],
  ] as const) {
    assert.throws(() => tokens.create(name), { code });
  }
  assert.equal(tokens.list().length, 1);
  assert.doesNotThrow(() => tokens.create("字".repeat(64)));
});

it("keeps the existing local token and tightens its file", (t) => {
  const data = dataDir(t);
  writeFileSync(data.path("auth.json"), JSON.stringify({ token: "existing-local-token" }), {
    mode: 0o644,
  });
  const tokens = store(t, data);
  assert.equal(tokens.localToken, "existing-local-token");
  assert.equal(tokens.isLocalToken("existing-local-token"), true);
  assert.equal(tokens.isLocalToken("another-token-value"), false);
  assert.equal(tokens.list().length, 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(data.path("auth.json")).mode & 0o777, 0o600);
  }
});

it("sees another process's deletion immediately and reports it once", (t) => {
  const data = dataDir(t);
  const first = store(t, data);
  const second = store(t, data);
  const removed: string[] = [];
  first.onRemoved((id) => removed.push(id));
  const { secret, token } = first.create("phone");
  assert.equal(second.resolve(secret), token.id);
  assert.equal(second.delete(token.id), true);
  assert.equal(first.resolve(secret), undefined);
  assert.deepEqual(removed, [token.id]);
  assert.equal(first.resolve(secret), undefined);
  assert.deepEqual(removed, [token.id]);
  assert.equal(second.delete(token.id), false);
});

it("does not bring a deleted token back from a stale process", (t) => {
  const data = dataDir(t);
  const stale = store(t, data);
  const other = store(t, data);
  const deleted = stale.create("deleted");
  assert.equal(other.has(deleted.token.id), true);
  assert.equal(other.delete(deleted.token.id), true);
  // Neither writing a token nor recording a use may restore what `stale` still remembers.
  const kept = stale.create("kept");
  stale.resolve(kept.secret);
  assert.deepEqual(
    other.list().map((token) => token.name),
    ["kept"],
  );
  assert.equal(other.resolve(deleted.secret), undefined);
});

it("records use at most once a minute and keeps it out of the tokens file", (t) => {
  const data = dataDir(t);
  const tokens = store(t, data);
  const { secret, token } = tokens.create("phone");
  const before = readFileSync(data.path("access-tokens.json"), "utf8");
  tokens.resolve(secret);
  const lastUsedAt = tokens.list()[0]?.lastUsedAt;
  assert.equal(typeof lastUsedAt, "number");
  assert.equal(readFileSync(data.path("access-tokens.json"), "utf8"), before);
  const usage = readFileSync(data.path("access-token-usage.json"), "utf8");
  tokens.resolve(secret);
  assert.equal(readFileSync(data.path("access-token-usage.json"), "utf8"), usage);
  assert.ok(JSON.parse(usage)[token.id]);
});

it("treats a request as local only when every signal says so", () => {
  const host = { host: "127.0.0.1:4400" };
  assert.equal(isLocalConnection(request(host)), true);
  assert.equal(isLocalConnection(request({ host: "localhost:4400" })), true);
  assert.equal(isLocalConnection(request(host, { remoteAddress: "::ffff:127.0.0.1" })), true);
  assert.equal(isLocalConnection(request(host, { remoteAddress: "::1" })), true);
  for (const candidate of [
    request(host, { remoteAddress: "192.168.1.2" }),
    request(host, { remoteAddress: "::ffff:100.64.0.1" }),
    request(host, { localPort: 4401 }),
    request({ host: "phone.example:4400" }),
    request({ host: "phone.example" }),
    request({ host: "127.0.0.1:4400.example.com" }),
    request({}),
    request({ ...host, "x-forwarded-for": "127.0.0.1" }),
    request({ ...host, "x-forwarded-host": "127.0.0.1:4400" }),
    request({ ...host, "x-forwarded-proto": "http" }),
    request({ ...host, forwarded: "for=127.0.0.1" }),
  ]) {
    assert.equal(isLocalConnection(candidate), false, JSON.stringify(candidate.headers));
  }
});

it("reads forwarding headers only from a configured proxy", () => {
  const forwarded = {
    host: "127.0.0.1:4400",
    origin: "https://phone.example",
    "x-forwarded-host": "phone.example",
    "x-forwarded-proto": "https",
    "x-forwarded-for": "198.51.100.1, 203.0.113.9",
  };
  const untrusted = new RequestTrust(undefined);
  assert.equal(untrusted.sameOrigin(request(forwarded)), false);
  assert.equal(untrusted.secure(request(forwarded)), false);
  assert.equal(untrusted.clientAddress(request(forwarded)), "127.0.0.1");
  const trusted = new RequestTrust("127.0.0.1, 10.0.0.1");
  assert.equal(trusted.sameOrigin(request(forwarded)), true);
  assert.equal(trusted.secure(request(forwarded)), true);
  assert.equal(trusted.clientAddress(request(forwarded)), "203.0.113.9");
  // A different direct peer gains nothing from a neighbouring entry in the list.
  const other = request(forwarded, { remoteAddress: "10.0.0.2" });
  assert.equal(trusted.sameOrigin(other), false);
  assert.equal(trusted.clientAddress(other), "10.0.0.2");
  assert.equal(new RequestTrust(undefined).sameOrigin(request({ origin: "null" })), false);
  assert.equal(new RequestTrust(undefined).sameOrigin(request({})), true);
  assert.throws(() => new RequestTrust("proxy.example"), /not an IP address/u);
});

it("blocks an address for a minute after ten failures in a minute", () => {
  let now = 0;
  const limit = new FailedSignInLimit(() => now);
  for (let failure = 0; failure < 9; failure += 1) limit.fail("a");
  assert.equal(limit.blocked("a"), false);
  limit.fail("a");
  assert.equal(limit.blocked("a"), true);
  assert.equal(limit.blocked("b"), false);
  now = 59_999;
  assert.equal(limit.blocked("a"), true);
  now = 60_000;
  assert.equal(limit.blocked("a"), false);
  limit.fail("a");
  assert.equal(limit.blocked("a"), false);
  // Failures spread over more than a minute never add up to a block.
  limit.fail("c");
  now += 60_000;
  for (let failure = 0; failure < 9; failure += 1) limit.fail("c");
  assert.equal(limit.blocked("c"), false);
});

it("destroys only the revoked credential's connections", () => {
  const connections = new CredentialConnections();
  const connection = () => {
    let close = () => {};
    return {
      destroyed: 0,
      destroy() {
        this.destroyed += 1;
      },
      once(_event: "close", listener: () => void) {
        close = listener;
      },
      closeNow: () => close(),
    };
  };
  const a = connection();
  const finished = connection();
  const released = connection();
  const b = connection();
  connections.track("a", a);
  connections.track("a", finished);
  connections.track("a", released)();
  connections.track("b", b);
  finished.closeNow();
  connections.revoke("a");
  assert.deepEqual(
    [a.destroyed, finished.destroyed, released.destroyed, b.destroyed],
    [1, 0, 0, 0],
  );
});

it("ties push subscriptions to their token and discards ones without a valid owner", async (t) => {
  const data = dataDir(t);
  data.writeJson("push-subscriptions.json", [
    { endpoint: "https://push.test/old", keys: { p256dh: "p", auth: "a" }, createdAt: 1 },
  ]);
  const push = new PushNotifier(data);
  const rpc = new RpcRegistry();
  push.register(rpc);
  const subscribe = (endpoint: string, credential?: string) =>
    rpc.dispatch(
      "codexhost/pushSubscribe",
      { args: { subscription: { endpoint, keys: { p256dh: "p", auth: "a" } } } },
      credential === undefined ? undefined : { credential, local: false, release: () => undefined },
    );
  const owners = () =>
    Object.fromEntries(
      data
        .readJson<Array<{ endpoint: string; owner?: string }>>("push-subscriptions.json", [])
        .map((entry) => [entry.endpoint.slice("https://push.test/".length), entry.owner]),
    );
  await subscribe("https://push.test/a", "token-a");
  await subscribe("https://push.test/b", "token-b");
  await subscribe("https://push.test/open");
  assert.deepEqual(owners(), {
    old: undefined,
    a: "token-a",
    b: "token-b",
    open: undefined,
  });

  push.dropOwner("token-a");
  assert.deepEqual(Object.keys(owners()), ["old", "b", "open"]);

  // Resubmitting after signing in with another token moves the same endpoint to it.
  await subscribe("https://push.test/b", "token-c");
  assert.equal(owners().b, "token-c");

  push.retainOwners((owner) => owner === "token-c");
  assert.deepEqual(owners(), { b: "token-c" });
});
