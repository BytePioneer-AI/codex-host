import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { it, type TestContext } from "node:test";
import * as acme from "acme-client";
import {
  AcmeRound,
  certificateKey,
  classifyFailure,
  issueCertificate,
} from "../src/remote-relay/acme.ts";
import {
  Certificates,
  nextAction,
  retryDelay,
  usableCertificate,
  type CertificateRecord,
} from "../src/remote-relay/certificates.ts";
import { RelayTls } from "../src/remote-relay/tls.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { acmeServer, type AcmeRequest } from "./support/acme-server.ts";
import { credentials, delay, relayData, until } from "./support/relay.ts";

it("allows slower dual-stack ACME connections without disabling IPv6", () => {
  assert.equal(acme.axios.defaults.httpsAgent.options.autoSelectFamilyAttemptTimeout, 2_000);
  assert.equal(acme.axios.defaults.httpsAgent.options.keepAlive, true);
  assert.equal(acme.axios.defaults.httpsAgent.options.family, undefined);
});

const host = "relay.test";
const endpoint = `remote-relay/endpoints/${encodeURIComponent(host)}`;
const stateFile = `${endpoint}/certificate-state.json`;
const hostname = "phone.relay.test";
const x509 = new X509Certificate(credentials.cert);
const notBefore = Date.parse(x509.validFrom);
const notAfter = Date.parse(x509.validTo);
const nowInValidity = notBefore + 100_000;

function fixture(t: TestContext, now = () => nowInValidity) {
  const data = relayData(t);
  const tls = new RelayTls(createServer(), new RequestTrust(undefined));
  const manager = new Certificates(
    data,
    tls,
    () => {},
    now,
    () => 0,
  );
  t.after(() => manager.stop());
  const record = (fields: Partial<CertificateRecord> = {}): CertificateRecord => ({
    hostname,
    directory: process.env.CODEXHOST_RELAY_ACME_DIRECTORY as string,
    failures: 1,
    validationFailures: 0,
    retryAt: now() + 600_000,
    ...fields,
  });
  const save = (fields: Partial<CertificateRecord> = {}) =>
    data.writeJson(stateFile, record(fields));
  const read = () =>
    data.readJson<CertificateRecord>(stateFile, undefined as unknown as CertificateRecord);
  const seedKey = () => {
    mkdirSync(data.path("remote-relay"), { recursive: true });
    writeFileSync(data.path("remote-relay/certificate-key.pem"), credentials.key);
  };
  const seed = () => {
    seedKey();
    mkdirSync(data.path(endpoint), { recursive: true });
    writeFileSync(data.path(endpoint, "certificate.pem"), credentials.cert);
  };
  return { data, tls, manager, record, save, read, seed, seedKey };
}

it("uses one certificate acceptance rule for hostname, time, key and TLS context", () => {
  const valid = usableCertificate(
    credentials.cert,
    credentials.key,
    "PHONE.RELAY.TEST",
    nowInValidity,
  );
  assert.ok(valid);
  assert.equal(
    nextAction(nowInValidity, valid, undefined),
    notBefore + ((notAfter - notBefore) * 2) / 3,
  );
  const renewal = notBefore + (notAfter - notBefore) * 0.8;
  assert.equal(nextAction(renewal, valid, undefined), renewal);
  const wrongKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  for (const [cert, key, host, now] of [
    [credentials.cert, credentials.key, "other.test", nowInValidity],
    [credentials.cert, Buffer.from(wrongKey), hostname, nowInValidity],
    [credentials.cert, credentials.key, hostname, notBefore - 1],
    [credentials.cert, credentials.key, hostname, notAfter],
    [Buffer.from("invalid PEM"), credentials.key, hostname, nowInValidity],
  ] as const) {
    const unusable = usableCertificate(cert, key, host, now);
    assert.equal(unusable, undefined);
    assert.equal(nextAction(now, unusable, undefined), now);
  }
});

it("nextAction respects backoff and pause; jitter never advances any backoff tier", (t) => {
  const f = fixture(t);
  assert.equal(nextAction(nowInValidity, undefined, f.record()), nowInValidity + 600_000);
  assert.equal(nextAction(nowInValidity, undefined, f.record({ paused: true })), undefined);
  for (const [i, base] of [600_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000].entries()) {
    assert.equal(retryDelay(i + 1, 0), base);
    assert.equal(retryDelay(i + 1, 1), base * 1.1);
    assert.ok(retryDelay(i + 1, 0.5) >= base);
  }
});

it("classifies only structured CAA/invalid fields, never detail text", () => {
  assert.equal(classifyFailure({ type: "urn:ietf:params:acme:error:caa" }, true).kind, "caa");
  assert.equal(classifyFailure({ detail: "CAA rejection" }, true).kind, "validation");
  assert.equal(classifyFailure({ detail: "CAA rejection" }).kind, "other");
  assert.equal(classifyFailure().problem, undefined);
});

it("creates and reuses exclusive P-256 PKCS#8 private keys with 0600 permissions", (t) => {
  const f = fixture(t);
  for (const name of ["acme-account.pem", "certificate-key.pem"] as const) {
    const key = certificateKey(f.data, name);
    assert.match(key.toString(), /BEGIN PRIVATE KEY/);
    assert.deepEqual(certificateKey(f.data, name), key);
    // Windows reports DOS attributes through stat.mode, not POSIX permission bits.
    if (process.platform !== "win32")
      assert.equal(statSync(f.data.path("remote-relay", name)).mode & 0o777, 0o600);
  }
});

it("a 429 has no library retry and preserves numeric Retry-After across restart and enable", async (t) => {
  const server = await acmeServer(t, ({ reply }) => {
    reply(
      429,
      { type: "urn:ietf:params:acme:error:rateLimited", detail: "quota" },
      { "retry-after": "7200" },
    );
    return true;
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture(t, () => now);
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(server.requests.length, 1);
  assert.equal(f.read().retryAt, now + 7_200_000);
  assert.equal(f.read().retryAfter, now + 7_200_000);
  assert.equal(f.read().detail, "quota");
  f.manager.stop();
  const restarted = new Certificates(
    f.data,
    f.tls,
    () => {},
    () => now,
    () => 0,
  );
  t.after(() => restarted.stop());
  restarted.start(hostname, host);
  assert.equal(restarted.state.issuing, false);
  restarted.stop();
  restarted.enable();
  restarted.start(hostname, host);
  assert.equal(f.read().failures, 0);
  assert.equal(f.read().validationFailures, 0);
  assert.equal(f.read().retryAt, now + 7_200_000);
  assert.equal(restarted.state.issuing, false);
  now += 7_200_000;
  restarted.check();
  await until(() => !restarted.state.issuing);
  assert.equal(server.requests.length, 2);
});

it("resets pause only on restart, not re-registration; enable clears counters and local backoff", async (t) => {
  const server = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "down" });
    return true;
  });
  const f = fixture(t);
  f.save({ paused: true, failures: 4, validationFailures: 2 });
  f.manager.start(hostname, host);
  assert.equal(f.read().paused, undefined);
  assert.equal(f.read().failures, 4);
  assert.equal(f.read().validationFailures, 2);
  f.save({ paused: true, failures: 4, validationFailures: 2 });
  f.manager.stop();
  f.manager.start(hostname, host);
  assert.equal(f.read().paused, true);
  f.manager.enable();
  f.manager.stop();
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(f.read().failures, 1);
  assert.equal(f.read().validationFailures, 0);
  assert.equal(f.read().paused, false);
  assert.equal(server.requests.length, 1);
});

for (const changed of ["hostname", "directory"] as const) {
  it(`ignores records for a different ${changed}`, async (t) => {
    await acmeServer(t, ({ reply }) => {
      reply(503, { detail: "down" });
      return true;
    });
    const f = fixture(t);
    f.save({ [changed]: "other", paused: true, failures: 7, retryAt: notAfter });
    f.manager.start(hostname, host);
    await until(() => !f.manager.state.issuing);
    assert.equal(f.read().failures, 1);
    assert.equal(f.read().hostname, hostname);
    assert.equal(f.read().directory, process.env.CODEXHOST_RELAY_ACME_DIRECTORY);
  });
}

it("writes backoff before requests, merges later on-disk waits, and pauses on CAA", async (t) => {
  let waiting: AcmeRequest | undefined;
  await acmeServer(t, (request) => {
    waiting = request;
    return true;
  });
  const f = fixture(t);
  f.manager.start(hostname, host);
  assert.equal(f.read().failures, 1);
  await until(() => waiting !== undefined);
  f.save({ retryAt: notAfter, retryAfter: notAfter - 100 });
  waiting?.reply(403, { type: "urn:ietf:params:acme:error:caa", detail: "CAA forbids issuance" });
  await until(() => !f.manager.state.issuing);
  assert.equal(f.read().retryAt, notAfter);
  assert.equal(f.read().retryAfter, notAfter - 100);
  assert.equal(f.read().paused, true);
});

it("authorization success clears validation failures even if finalize fails", async (t) => {
  await acmeServer(t, ({ path, reply }) => {
    if (path !== "/finalize") return false;
    reply(500, { detail: "finalize unavailable" });
    return true;
  });
  const f = fixture(t);
  f.save({ validationFailures: 1, retryAt: 0 });
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(f.read().validationFailures, 0);
  assert.equal(f.read().detail, "finalize unavailable");
});

it("polling 429 honors HTTP-date Retry-After instead of polling again", async (t) => {
  const retryAfter = new Date(Date.now() + 14_400_000).toUTCString();
  const server = await acmeServer(t, ({ path, reply }) => {
    if (path === "/finalize") {
      reply(200, { status: "processing" }, { "retry-after": "0" });
      return true;
    }
    if (path === "/order/1") {
      reply(429, { detail: "poll later" }, { "retry-after": retryAfter });
      return true;
    }
    return false;
  });
  const f = fixture(t, Date.now);
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(f.read().retryAt, Date.parse(retryAfter));
  assert.equal(server.requests.filter((request) => request.path === "/order/1").length, 1);
  f.manager.check();
  assert.equal(f.manager.state.issuing, false);
});

it("invalidation during a poll wait sends no further requests and keeps prewritten backoff", async (t) => {
  const server = await acmeServer(t, ({ path, reply }) => {
    if (path !== "/finalize") return false;
    reply(200, { status: "processing" }, { "retry-after": "1" });
    return true;
  });
  const f = fixture(t);
  f.manager.start(hostname, host);
  await until(() => server.requests.some((request) => request.path === "/finalize"));
  f.manager.stop();
  const saved = readFileSync(f.data.path(stateFile));
  await delay(1_100);
  assert.equal(
    server.requests.some((request) => request.path === "/order/1"),
    false,
  );
  assert.deepEqual(readFileSync(f.data.path(stateFile)), saved);
});

it("late old responses cannot alter a new round's errors or persisted waits", async (t) => {
  const waiting: AcmeRequest[] = [];
  await acmeServer(t, (request) => {
    waiting.push(request);
    return true;
  });
  let now = nowInValidity;
  const f = fixture(t, () => now);
  f.manager.start(hostname, host);
  await until(() => waiting.length === 1);
  f.manager.stop();
  now = f.read().retryAt;
  f.manager.start(hostname, host);
  await until(() => waiting.length === 2);
  waiting[1]?.reply(503, { detail: "new round" });
  await until(() => !f.manager.state.issuing);
  const saved = readFileSync(f.data.path(stateFile));
  waiting[0]?.reply(
    403,
    { type: "urn:ietf:params:acme:error:caa", detail: "old round" },
    { "retry-after": "999999" },
  );
  await delay(50);
  assert.deepEqual(readFileSync(f.data.path(stateFile)), saved);
  assert.equal(f.read().detail, "new round");
  assert.equal(f.read().paused, false);
});

it(
  "a real 30-second request timeout is a network failure without library retry",
  { timeout: 40_000 },
  async (t) => {
    const server = await acmeServer(t, () => true);
    const f = fixture(t, Date.now);
    assert.equal(acme.axios.defaults.timeout, 30_000);
    f.manager.start(hostname, host);
    await until(() => !f.manager.state.issuing, 35_000);
    assert.equal(server.requests.length, 1);
    assert.equal(f.read().detail, undefined);
    assert.equal(f.manager.state.failure?.detail, undefined);
    assert.equal(f.read().failures, 1);
  },
);

it("installs only usable certificates atomically, removes success records, and withdraws expired certificates", async (t) => {
  await acmeServer(t);
  let now = nowInValidity;
  const f = fixture(t, () => now);
  f.seedKey();
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(f.tls.available, true);
  assert.equal(existsSync(f.data.path(stateFile)), false);
  if (process.platform !== "win32")
    assert.equal(statSync(f.data.path(endpoint, "certificate.pem")).mode & 0o777, 0o600);
  assert.equal(f.manager.state.expiresAt, new Date(notAfter).toISOString());
  f.save({ retryAt: notAfter + 100_000 });
  now = notAfter;
  f.manager.check();
  assert.equal(f.tls.available, false);
  assert.equal(f.manager.state.expiresAt, undefined);
});

it("a round's ten-minute deadline invalidates it and removes its challenge only once", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const round = new AcmeRound(f.tls);
  round.setChallenge(hostname, credentials.cert, credentials.key);
  const clear = t.mock.method(f.tls, "clearChallenge", f.tls.clearChallenge.bind(f.tls));
  t.mock.timers.tick(600_000);
  assert.throws(() => round.assertActive());
  const second = new AcmeRound(f.tls);
  second.setChallenge(hostname, credentials.cert, credentials.key);
  round.stop();
  assert.equal(clear.mock.callCount(), 1);
  second.stop();
});

it("account lookup creates only on accountDoesNotExist and otherwise preserves the error", async (t) => {
  let missing = true;
  const server = await acmeServer(t, ({ path, payload, reply }) => {
    if (path !== "/account" || !payload?.onlyReturnExisting) return false;
    reply(400, {
      type: missing
        ? "urn:ietf:params:acme:error:accountDoesNotExist"
        : "urn:ietf:params:acme:error:unauthorized",
    });
    missing = false;
    return true;
  });
  const f = fixture(t);
  const first = new AcmeRound(f.tls);
  try {
    await issueCertificate(first, f.data, hostname, server.directory, () => {});
  } finally {
    first.stop();
  }
  assert.equal(
    server.requests.filter((request) => request.payload?.termsOfServiceAgreed).length,
    1,
  );
  const second = new AcmeRound(f.tls);
  try {
    await assert.rejects(issueCertificate(second, f.data, hostname, server.directory, () => {}));
  } finally {
    second.stop();
  }
  assert.equal(
    server.requests.filter((request) => request.payload?.termsOfServiceAgreed).length,
    1,
  );
});

it("restart does not re-pause on a transient error with two historical validation failures", async (t) => {
  await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "unavailable" });
    return true;
  });
  const f = fixture(t);
  f.save({ paused: true, validationFailures: 2, retryAt: 0 });
  f.manager.start(hostname, host);
  await until(() => !f.manager.state.issuing);
  assert.equal(f.read().validationFailures, 2);
  assert.equal(f.read().paused, false);
});

it("a successful library badNonce retry clears its structured error", async (t) => {
  let nonceRejected = false;
  const server = await acmeServer(t, ({ path, reply }) => {
    if (path !== "/order" || nonceRejected) return false;
    nonceRejected = true;
    reply(
      400,
      { type: "urn:ietf:params:acme:error:badNonce", detail: "nonce used" },
      { "retry-after": "999999" },
    );
    return true;
  });
  const f = fixture(t);
  const round = new AcmeRound(f.tls);
  try {
    await issueCertificate(round, f.data, hostname, server.directory, () => {});
  } finally {
    round.stop();
  }
  assert.equal(round.responseFailure, undefined);
  assert.equal(round.retryAfter, undefined);
  assert.equal(server.requests.filter((request) => request.path === "/order").length, 2);
  assert.equal(server.requests.find((request) => request.path === "/account/1")?.payload, null);
});

for (const type of ["caa", "serverInternal"]) {
  it(`classifies an HTTP 200 invalid order with ${type}`, async (t) => {
    await acmeServer(t, ({ path, reply }) => {
      if (path !== "/finalize") return false;
      reply(200, {
        status: "invalid",
        error: { type: `urn:ietf:params:acme:error:${type}`, detail: "order refused" },
      });
      return true;
    });
    const f = fixture(t);
    f.manager.start(hostname, host);
    await until(() => !f.manager.state.issuing);
    assert.equal(f.read().paused, type === "caa");
    assert.equal(f.read().validationFailures, 0);
    assert.equal(f.read().detail, "order refused");
  });
}
