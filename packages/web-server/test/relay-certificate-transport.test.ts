import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { it } from "node:test";
import * as acme from "acme-client";
import { AcmeRound, issueCertificate } from "../src/remote-relay/acme.ts";
import { Certificates, type CertificateRecord } from "../src/remote-relay/certificates.ts";
import { RelayTls } from "../src/remote-relay/tls.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { acmeServer } from "./support/acme-server.ts";
import { certificateProxy, certificateRelay } from "./support/certificate-relay.ts";
import { environment } from "./support/pebble.ts";
import { credentials, relayData, until } from "./support/relay.ts";

const hostname = "phone.relay.test";
const hmac = Buffer.from([251, 255, 239, 250, 239, 255, 237, 255]);
const account = { keyId: "external-key", hmacKey: hmac.toString("base64url") };

for (const proxy of [false, true]) {
  it(`routes every ACME request, including nonce, through the relay${proxy ? " via HTTPS_PROXY" : ""}`, async (t) => {
    const ca = await acmeServer(t);
    const relay = await certificateRelay(t, ca.directory);
    const upstream = proxy ? await certificateProxy(t, relay.host) : undefined;
    if (upstream) environment(t, { HTTPS_PROXY: upstream.url });
    const direct = t.mock.method(acme.axios.defaults.httpsAgent, "createConnection", () => {
      throw new Error("Direct CA access is unavailable");
    });
    const tls = new RelayTls(createServer(), new RequestTrust(undefined));
    const round = new AcmeRound(tls, relay);
    t.after(() => round.stop());
    const certificate = await issueCertificate(
      round,
      relayData(t),
      hostname,
      ca.directory,
      () => {},
    );
    assert.equal(certificate, credentials.cert.toString());
    assert.equal(direct.mock.callCount(), 0);
    assert.ok(ca.requests.some((request) => request.path === "/nonce"));
    assert.ok(ca.requests.some((request) => request.path === "/certificate"));
    assert.ok(relay.targets.length > 0);
    assert.equal(new Set(ca.requests.map((item) => item.remotePort)).size, relay.targets.length);
    assert.equal(relay.requests.length, 0, "existing accounts never claim EAB");
    if (upstream) assert.equal(upstream.targets.length, relay.targets.length);
    const transport = round.transport;
    assert.ok(transport);
    const destroy = t.mock.method(transport, "destroy", transport.destroy.bind(transport));
    round.stop();
    assert.equal(destroy.mock.callCount(), 1);
  });
}

for (const { status, contact } of [
  { status: 200 },
  { status: 200, contact: ["mailto:ops@example.com"] },
  { status: 404 },
]) {
  it(`claims EAB only after accountDoesNotExist and handles HTTP ${status}${contact ? " with contact" : " without contact"}`, async (t) => {
    const ca = await acmeServer(t, ({ path, payload, reply }) => {
      if (path !== "/account" || !payload?.onlyReturnExisting) return false;
      reply(400, { type: "urn:ietf:params:acme:error:accountDoesNotExist" });
      return true;
    });
    const relay = await certificateRelay(t, ca.directory, {
      status,
      account: { ...account, ...(contact === undefined ? {} : { contact }) },
    });
    const proxy = await certificateProxy(t, relay.host);
    environment(t, { HTTPS_PROXY: proxy.url });
    const round = new AcmeRound(new RelayTls(createServer(), new RequestTrust(undefined)), relay);
    t.after(() => round.stop());
    await issueCertificate(round, relayData(t), hostname, ca.directory, () => {});
    assert.equal(relay.requests.length, 1);
    assert.equal(proxy.targets.length, relay.targets.length + 1, "EAB also uses the HTTP proxy");
    const creation = ca.requests.find((request) => request.payload?.termsOfServiceAgreed);
    assert.ok(creation);
    assert.deepEqual(creation.payload?.contact, contact);
    assert.equal(Object.hasOwn(creation.payload ?? {}, "contact"), contact !== undefined);
    assert.equal(
      ca.requests.find((request) => request.payload?.onlyReturnExisting)?.payload?.contact,
      undefined,
    );
    const eab = creation.payload?.externalAccountBinding as
      | {
          protected: string;
          payload: string;
          signature: string;
        }
      | undefined;
    if (status === 404) assert.equal(eab, undefined);
    else {
      assert.ok(eab);
      assert.equal(
        JSON.parse(Buffer.from(eab.protected, "base64url").toString()).kid,
        account.keyId,
      );
      assert.equal(
        eab.signature,
        createHmac("sha256", hmac).update(`${eab.protected}.${eab.payload}`).digest("base64url"),
      );
    }
  });
}

for (const status of [429, 503, 401]) {
  it(`records EAB HTTP ${status} as a transient round failure without creating an account`, async (t) => {
    const ca = await acmeServer(t, ({ path, payload, reply }) => {
      if (path !== "/account" || !payload?.onlyReturnExisting) return false;
      reply(400, { type: "urn:ietf:params:acme:error:accountDoesNotExist" });
      return true;
    });
    environment(t, { CODEXHOST_RELAY_ACME_DIRECTORY: undefined });
    const relay = await certificateRelay(t, ca.directory, {
      status,
      ...(status === 429 ? { retryAfter: "7200" } : {}),
    });
    const data = relayData(t);
    const now = Date.now();
    const manager = new Certificates(
      data,
      new RelayTls(createServer(), new RequestTrust(undefined)),
      () => {},
      () => now,
      () => 0,
    );
    t.after(() => manager.stop());
    manager.start(hostname, relay.host, {
      hostname,
      token: relay.token,
      certificateAuthority: { directory: ca.directory },
    });
    await until(() => !manager.state.issuing);
    const record = data.readJson<CertificateRecord>(
      `remote-relay/endpoints/${encodeURIComponent(relay.host)}/certificate-state.json`,
      {} as CertificateRecord,
    );
    assert.equal(record.validationFailures, 0);
    assert.equal(record.paused, false);
    assert.equal(record.failures, 1);
    if (status === 429) {
      assert.ok((record.retryAfter ?? 0) >= now + 7_200_000);
      assert.equal(record.retryAt, record.retryAfter);
    } else assert.equal(record.retryAt, now + 600_000);
    assert.equal(ca.requests.filter((request) => request.payload?.termsOfServiceAgreed).length, 0);
    assert.equal(relay.requests.length, 1);
  });
}

it("verifies the CA hostname inside the tunnel rather than trusting the relay's TLS", async (t) => {
  const ca = await acmeServer(t);
  const directory = ca.directory.replace("localhost", "wrong.test");
  const relay = await certificateRelay(t, directory);
  const round = new AcmeRound(new RelayTls(createServer(), new RequestTrust(undefined)), relay);
  t.after(() => round.stop());
  await assert.rejects(
    issueCertificate(round, relayData(t), hostname, directory, () => {}),
    /Hostname\/IP does not match certificate's altnames/,
  );
  assert.equal(ca.requests.length, 0);
  assert.equal(relay.targets.length, 1);
});

it("verifies the control hostname even when HTTPS_PROXY supplies the connection", async (t) => {
  const ca = await acmeServer(t);
  const relay = await certificateRelay(t, ca.directory);
  const host = relay.host.replace("localhost", "wrong.test");
  const proxy = await certificateProxy(t, host);
  environment(t, { HTTPS_PROXY: proxy.url });
  const round = new AcmeRound(new RelayTls(createServer(), new RequestTrust(undefined)), {
    host,
    token: relay.token,
  });
  t.after(() => round.stop());
  await assert.rejects(
    issueCertificate(round, relayData(t), hostname, ca.directory, () => {}),
    /Hostname\/IP does not match certificate's altnames/,
  );
  assert.equal(relay.targets.length, 0);
  assert.equal(proxy.targets.length, 1);
});
