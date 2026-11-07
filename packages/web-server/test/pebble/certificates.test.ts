import assert from "node:assert/strict";
import { createPublicKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import * as acme from "acme-client";
import { Certificates, type CertificateRecord } from "../../src/remote-relay/certificates.ts";
import { RemoteRelay } from "../../src/remote-relay/state.ts";
import { connectRelay } from "../../src/remote-relay/client.ts";
import { RelayTls } from "../../src/remote-relay/tls.ts";
import { RequestTrust } from "../../src/request-trust.ts";
import { credentials, delay, until } from "../support/relay.ts";
import { connect, createSecureContext } from "node:tls";
import { it } from "node:test";
import { AcmeFailure, AcmeRound, issueCertificate } from "../../src/remote-relay/acme.ts";
import { environment, httpProxy, pebble } from "../support/pebble.ts";

it(
  "pauses after two real validation failures and does not retry on re-registration",
  { timeout: 60_000 },
  async (t) => {
    const f = await pebble(t, 0);
    environment(t, { CODEXHOST_RELAY_ACME_DIRECTORY: f.directory });
    let now = Date.now();
    const manager = new Certificates(
      f.data,
      f.tls,
      () => {},
      () => now,
      () => 0,
    );
    t.after(() => manager.stop());
    const challenges = t.mock.method(f.tls, "setChallenge", () => {});
    const host = `localhost:${f.relay.port}`;
    manager.start(f.hostname, host);
    await until(() => !manager.state.issuing, 15_000);
    const read = () =>
      f.data.readJson<CertificateRecord>(
        `remote-relay/endpoints/${encodeURIComponent(host)}/certificate-state.json`,
        {} as CertificateRecord,
      );
    assert.equal(read().validationFailures, 1);
    now = read().retryAt;
    manager.check();
    await until(() => !manager.state.issuing, 15_000);
    assert.equal(read().validationFailures, 2);
    assert.equal(manager.state.failure?.paused, true);
    manager.stop();
    manager.start(f.hostname, host);
    assert.equal(manager.state.issuing, false);
    assert.equal(challenges.mock.callCount(), 2);
  },
);

it(
  "rejects an unusable renewal and preserves the old certificate file and TLS context",
  { timeout: 60_000 },
  async (t) => {
    const f = await pebble(t, 0);
    environment(t, { CODEXHOST_RELAY_ACME_DIRECTORY: f.directory });
    let offset = 0;
    const manager = new Certificates(
      f.data,
      f.tls,
      () => {},
      () => Date.now() + offset,
      () => 0,
    );
    t.after(() => manager.stop());
    const host = `localhost:${f.relay.port}`;
    const endpoint = `remote-relay/endpoints/${encodeURIComponent(host)}`;
    manager.start(f.hostname, host);
    await until(() => !manager.state.issuing, 15_000);
    assert.equal(manager.state.failure, undefined);
    const original = readFileSync(f.data.path(endpoint, "certificate.pem"));
    const cert = new X509Certificate(original);
    offset =
      Date.parse(cert.validFrom) +
      (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) * 0.7 -
      Date.now();
    const download = acme.Client.prototype.getCertificate;
    t.mock.method(
      acme.Client.prototype,
      "getCertificate",
      async function (this: acme.Client, order: acme.Order) {
        await download.call(this, order);
        return credentials.cert.toString();
      },
    );
    manager.check();
    await until(() => !manager.state.issuing, 15_000);
    assert.ok(manager.state.failure);
    assert.deepEqual(readFileSync(f.data.path(endpoint, "certificate.pem")), original);
    const phone = connect({
      host: "127.0.0.1",
      port: f.relay.port,
      servername: f.hostname,
      ca: f.root,
    });
    t.after(() => phone.destroy());
    await once(phone, "secureConnect");
    assert.equal(phone.getPeerCertificate().serialNumber, cert.serialNumber);
    phone.destroy();
  },
);

it(
  "replacement invalidates an issuing RemoteRelay and prevents certificate writes",
  { timeout: 60_000 },
  async (t) => {
    const f = await pebble(t, 0);
    f.disconnect();
    environment(t, { CODEXHOST_RELAY_ACME_DIRECTORY: f.directory });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let polling = false;
    t.mock.method(AcmeRound.prototype, "wait", async () => {
      polling = true;
      await waiting;
    });
    const clear = t.mock.method(
      RelayTls.prototype,
      "clearChallenge",
      RelayTls.prototype.clearChallenge,
    );
    f.data.writeJson("service.json", { relayHost: `localhost:${f.relay.port}` });
    const web = new RemoteRelay(f.data, true, createServer(), new RequestTrust(undefined));
    t.after(() => web.close());
    web.start();
    await until(() => polling, 15_000);
    let replaced = false;
    const disconnect = connectRelay({
      host: `localhost:${f.relay.port}`,
      identity: f.identity,
      connecting() {},
      registered() {
        replaced = true;
      },
      stopped() {},
      tcp(stream) {
        stream.close();
      },
    });
    t.after(disconnect);
    await until(() => replaced && web.state.status === "stopped");
    const endpoint = `remote-relay/endpoints/${encodeURIComponent(`localhost:${f.relay.port}`)}`;
    const saved = readFileSync(f.data.path(endpoint, "certificate-state.json"));
    release();
    await delay(100);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(existsSync(f.data.path(endpoint, "certificate.pem")), false);
    assert.deepEqual(readFileSync(f.data.path(endpoint, "certificate-state.json")), saved);
  },
);

for (const reuse of [0, 100] as const) {
  it(
    `issues and renews through Relay with authorization reuse ${reuse}% and CONNECT proxy`,
    { timeout: 90_000 },
    async (t) => {
      const f = await pebble(t, reuse);
      let challenges = 0;
      const set = f.tls.setChallenge.bind(f.tls);
      t.mock.method(f.tls, "setChallenge", (...args: Parameters<typeof set>) => {
        challenges++;
        set(...args);
      });
      const issue = async () => {
        const round = new AcmeRound(f.tls);
        try {
          return await issueCertificate(round, f.data, f.hostname, f.directory, () => {});
        } finally {
          round.stop();
        }
      };
      const cert = await issue();
      const keyPath = f.data.path("remote-relay/certificate-key.pem");
      const key = readFileSync(keyPath);
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
      f.tls.useCertificate(createSecureContext({ cert, key }));
      const phone = connect({
        host: "127.0.0.1",
        port: f.relay.port,
        servername: f.hostname,
        ca: f.root,
        ALPNProtocols: ["http/1.1"],
      });
      t.after(() => phone.destroy());
      await once(phone, "secureConnect");
      assert.equal(phone.authorized, true);
      phone.destroy();
      const targets = await httpProxy(t);
      const renewed = await issue();
      assert.ok(targets.length > 0);
      assert.ok(targets.every((target) => target === "localhost:4492"));
      assert.equal(challenges, reuse === 100 ? 1 : 2);
      assert.deepEqual(readFileSync(keyPath), key);
      assert.ok(new X509Certificate(renewed).publicKey.equals(createPublicKey(key)));
    },
  );
}

it(
  "classifies an HTTP 200 invalid authorization as validation failure when challenge answering is disabled",
  { timeout: 60_000 },
  async (t) => {
    const f = await pebble(t, 0);
    t.mock.method(f.tls, "setChallenge", () => {});
    const round = new AcmeRound(f.tls);
    t.after(() => round.stop());
    await assert.rejects(
      issueCertificate(round, f.data, f.hostname, f.directory, () => {}),
      (error) => {
        assert.ok(error instanceof AcmeFailure);
        assert.equal(error.kind, "validation");
        assert.ok(error.problem?.detail);
        assert.equal(round.responseFailure, undefined);
        return true;
      },
    );
  },
);
