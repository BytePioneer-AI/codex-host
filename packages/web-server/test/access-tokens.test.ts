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

it("creates the access token when first viewed and keeps it after reopening the store", (t) => {
  const data = dataDir(t);
  const tokens = store(t, data);
  assert.equal(tokens.resolve("anything"), undefined);
  const { secret, lastUsedAt } = tokens.current();
  assert.equal(lastUsedAt, null);
  assert.equal(Buffer.from(secret, "base64url").length, 32);
  assert.equal(typeof tokens.resolve(secret), "string");
  assert.equal(tokens.resolve("not-a-token"), undefined);
  assert.equal(tokens.current().secret, secret);
  assert.equal(store(t, data).current().secret, secret);
  if (process.platform !== "win32") {
    assert.equal(statSync(data.path("access-token.json")).mode & 0o777, 0o600);
    assert.equal(statSync(data.path("auth.json")).mode & 0o777, 0o600);
  }
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
  if (process.platform !== "win32") {
    assert.equal(statSync(data.path("auth.json")).mode & 0o777, 0o600);
  }
});

it("sees another process's regeneration immediately and reports it once", (t) => {
  const data = dataDir(t);
  const first = store(t, data);
  const second = store(t, data);
  const revoked: string[] = [];
  first.onRevoked((id) => revoked.push(id));
  const { secret } = first.current();
  const id = first.resolve(secret) as string;
  assert.equal(second.resolve(secret), id);
  const replacement = second.regenerate().secret;
  assert.notEqual(replacement, secret);
  assert.equal(first.resolve(secret), undefined);
  assert.equal(first.has(id), false);
  assert.deepEqual(revoked, [id]);
  assert.equal(first.resolve(secret), undefined);
  assert.deepEqual(revoked, [id]);
  assert.equal(typeof first.resolve(replacement), "string");
  assert.equal(first.current().secret, replacement);
});

it("does not bring a replaced token back from a stale process", (t) => {
  const data = dataDir(t);
  const stale = store(t, data);
  const other = store(t, data);
  const replaced = stale.current().secret;
  assert.equal(typeof other.resolve(replaced), "string");
  const current = other.regenerate().secret;
  // Neither reading the token nor recording a use may restore what `stale` still remembers.
  assert.equal(stale.resolve(replaced), undefined);
  assert.equal(stale.current().secret, current);
  assert.equal(other.resolve(replaced), undefined);
});

it("records use at most once a minute, keeps it out of the token file, and forgets it on regeneration", (t) => {
  const data = dataDir(t);
  const tokens = store(t, data);
  const { secret } = tokens.current();
  const before = readFileSync(data.path("access-token.json"), "utf8");
  const id = tokens.resolve(secret) as string;
  assert.equal(typeof tokens.current().lastUsedAt, "number");
  assert.equal(readFileSync(data.path("access-token.json"), "utf8"), before);
  const usage = readFileSync(data.path("access-token-usage.json"), "utf8");
  tokens.resolve(secret);
  assert.equal(readFileSync(data.path("access-token-usage.json"), "utf8"), usage);
  assert.ok(JSON.parse(usage)[id]);
  assert.equal(tokens.regenerate().lastUsedAt, null);
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
