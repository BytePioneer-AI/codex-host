import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { X509Certificate } from "node:crypto";
import { it } from "node:test";
import { readServiceOptions, saveServiceOptions } from "../src/background-service.ts";
import { RemoteRelay } from "../src/remote-relay/state.ts";
import type { connectRelay } from "../src/remote-relay/client.ts";
import { OFFICIAL_RELAY_HOST, relayKind } from "../src/remote-relay/settings.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { credentials, relayData } from "./support/relay.ts";

type Connection = Parameters<typeof connectRelay>[0];

it("recognizes enabled legacy official settings without resetting the address or certificate", (t) => {
  const data = relayData(t);
  const hostname = "phone.relay.test";
  data.writeJson("service.json", {
    relayHost: OFFICIAL_RELAY_HOST,
    relayEnabled: true,
    relayName: "alice",
    relayInvite: "invite-code",
    relayHostname: hostname,
  });
  const legacy = readFileSync(data.path("service.json"));
  assert.deepEqual(readServiceOptions(data).relayRegistrations[OFFICIAL_RELAY_HOST], {
    name: "alice",
    invite: "invite-code",
    hostname,
  });
  assert.deepEqual(readFileSync(data.path("service.json")), legacy);
  data.writeJson("remote-relay/certificate-state.json", {
    hostname,
    directory: "https://test-ca.invalid/directory",
  });
  writeFileSync(data.path("remote-relay/certificate.pem"), credentials.cert);
  writeFileSync(data.path("remote-relay/certificate-key.pem"), credentials.key);
  const record = readFileSync(data.path("remote-relay/certificate-state.json"));
  const certificate = new X509Certificate(credentials.cert);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(certificate.validFrom) + 100_000 });
  const connections: Connection[] = [];
  const web = new RemoteRelay(
    data,
    true,
    createServer(),
    new RequestTrust(undefined),
    (connection) => {
      connections.push(connection);
      connection.connecting();
      connection.registered(hostname);
      return () => {};
    },
  );
  t.after(() => web.close());
  assert.equal(web.access.kind, "official");
  assert.equal(web.access.enabled, true);
  assert.equal(web.access.officialHostname, hostname);
  assert.equal(saveServiceOptions(data, { relay: OFFICIAL_RELAY_HOST }), false);
  saveServiceOptions(data, { port: "4401" });
  assert.equal(readServiceOptions(data).relayKind, undefined);
  assert.equal(
    readServiceOptions(data).relayRegistrations[OFFICIAL_RELAY_HOST]?.hostname,
    hostname,
  );
  const persisted = data.readJson<Record<string, unknown>>("service.json", {});
  for (const field of ["relayName", "relayInvite", "relayHostname"])
    assert.equal(field in persisted, false);
  assert.equal(connections.length, 0); // Reading legacy settings does not trigger registration.
  web.start(); // Normal process startup needs no disable/re-enable or new registration inputs.
  assert.equal(web.access.state.status, "connected");
  assert.equal(web.access.kind, "official");
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.host, OFFICIAL_RELAY_HOST);
  assert.equal(connections[0]?.name, "alice");
  assert.equal(connections[0]?.invite, "invite-code");
  const endpoint = `remote-relay/endpoints/${encodeURIComponent(OFFICIAL_RELAY_HOST)}`;
  assert.deepEqual(readFileSync(data.path(endpoint, "certificate.pem")), credentials.cert);
  assert.deepEqual(readFileSync(data.path("remote-relay/certificate-key.pem")), credentials.key);
  assert.deepEqual(readFileSync(data.path(endpoint, "certificate-state.json")), record);
  assert.equal(existsSync(data.path("remote-relay/certificate.pem")), false);
  assert.equal(existsSync(data.path("remote-relay/certificate-state.json")), false);
  assert.equal(web.access.officialHostname, hostname);
  assert.equal(connections.length, 1);
  assert.equal(
    relayKind({ relayHost: OFFICIAL_RELAY_HOST, relayKind: "self-hosted" }),
    "self-hosted",
  );
  const fresh = relayData(t);
  saveServiceOptions(fresh, { relay: OFFICIAL_RELAY_HOST });
  assert.equal(relayKind(readServiceOptions(fresh)), "official");
});

it("drops legacy certificates when the CLI changed the control address before migration", (t) => {
  const data = relayData(t);
  data.writeJson("service.json", { relayHost: "old.relay.test", relayHostname: "same.relay.test" });
  data.writeJson("remote-relay/certificate-state.json", { hostname: "same.relay.test" });
  writeFileSync(data.path("remote-relay/certificate.pem"), "old certificate");
  saveServiceOptions(data, { relay: "new.relay.test" });
  const web = new RemoteRelay(
    data,
    true,
    createServer(),
    new RequestTrust(undefined),
    () => () => {},
  );
  t.after(() => web.close());
  for (const file of ["certificate.pem", "certificate-state.json"]) {
    assert.equal(existsSync(data.path("remote-relay", file)), false);
    for (const host of ["old.relay.test", "new.relay.test"])
      assert.equal(existsSync(data.path("remote-relay/endpoints", host, file)), false);
  }
  assert.equal(web.access.customHostname, undefined);
  assert.equal(
    readServiceOptions(data).relayRegistrations["old.relay.test"]?.hostname,
    "same.relay.test",
  );
});

it("uses the official default, switches only while off, isolates assignments and preserves identity", (t) => {
  const data = relayData(t);
  const connections: Connection[] = [];
  let disconnects = 0;
  const web = new RemoteRelay(
    data,
    true,
    createServer(),
    new RequestTrust(undefined),
    (connection) => {
      connections.push(connection);
      connection.connecting();
      return () => {
        disconnects++;
      };
    },
  );
  t.after(() => web.close());
  assert.equal(web.access.kind, "official");
  assert.equal(web.access.officialHost, OFFICIAL_RELAY_HOST);
  assert.equal(web.access.enabled, false);
  web.setEnabled(true, { name: "alice", invite: "secret" });
  assert.equal(connections[0]?.host, OFFICIAL_RELAY_HOST);
  assert.equal(connections[0]?.invite, "secret");
  const identity = readFileSync(data.path("remote-relay/identity.pem"));
  for (const enabled of [true, false]) {
    assert.throws(
      () => web.setEnabled(enabled, undefined, { kind: "self-hosted", host: "relay.example.com" }),
      /Turn off/,
    );
    assert.equal(web.access.enabled, true);
  }
  assert.equal(disconnects, 0);
  const hostname = "phone.relay.test";
  const certificate = new X509Certificate(credentials.cert);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(certificate.validFrom) + 100_000 });
  const endpoint = `remote-relay/endpoints/${encodeURIComponent(OFFICIAL_RELAY_HOST)}`;
  data.writeJson(`${endpoint}/certificate-state.json`, { hostname });
  writeFileSync(data.path(endpoint, "certificate.pem"), credentials.cert);
  writeFileSync(data.path("remote-relay/certificate-key.pem"), credentials.key);
  connections[0]?.registered(hostname);
  assert.equal(web.state.status, "connected");
  assert.equal("certificate" in web.state && web.state.certificate.issuing, false);
  web.setEnabled(false);
  web.setEnabled(false, undefined, { kind: "self-hosted", host: "relay.example.com" });
  assert.equal(web.access.customHostname, undefined);
  assert.equal(web.access.officialHostname, hostname);
  assert.deepEqual(readFileSync(data.path(endpoint, "certificate.pem")), credentials.cert);
  assert.equal(existsSync(data.path(endpoint, "certificate-state.json")), true);
  assert.equal(readServiceOptions(data).relayRegistrations[OFFICIAL_RELAY_HOST]?.invite, "secret");
  assert.deepEqual(readFileSync(data.path("remote-relay/identity.pem")), identity);
  web.setEnabled(true, { name: "alice", invite: "must-not-leak" });
  assert.equal(connections[1]?.host, "relay.example.com");
  assert.equal(connections[1]?.name, "alice");
  assert.equal(connections[1]?.invite, "");
  assert.equal(readServiceOptions(data).relayRegistrations["relay.example.com"]?.name, "alice");
  assert.equal(readServiceOptions(data).relayRegistrations["relay.example.com"]?.invite, undefined);
  web.setEnabled(false);
  web.setEnabled(true, undefined, { kind: "official" });
  assert.equal(connections[2]?.host, OFFICIAL_RELAY_HOST);
  assert.equal(connections[2]?.name, "alice");
  assert.equal(connections[2]?.invite, "secret");
  connections[2]?.registered(hostname);
  assert.equal(web.access.officialHostname, hostname);
  assert.equal(web.state.status, "connected");
  assert.equal("certificate" in web.state && web.state.certificate.issuing, false);
  assert.deepEqual(readFileSync(data.path(endpoint, "certificate.pem")), credentials.cert);
  assert.equal(web.access.customHost, "relay.example.com");
  assert.deepEqual(readFileSync(data.path("remote-relay/identity.pem")), identity);
});

it("CLI only changes the self-hosted address, preserves explicit official selection, and requires off", (t) => {
  const data = relayData(t);
  data.writeJson("service.json", {
    relayKind: "official",
    relayEnabled: false,
    relayHostname: "alice.chost.dev",
  });
  saveServiceOptions(data, { relay: "localhost:4498" });
  assert.equal(readServiceOptions(data).relayKind, "official");
  assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
  assert.equal(
    readServiceOptions(data).relayRegistrations[OFFICIAL_RELAY_HOST]?.hostname,
    "alice.chost.dev",
  );
  saveServiceOptions(data, { relay: "" });
  assert.equal(readServiceOptions(data).relayKind, "official");
  assert.equal(readServiceOptions(data).relayHost, undefined);
  data.writeJson("service.json", { relayHost: "localhost:4498", relayEnabled: true });
  assert.throws(() => saveServiceOptions(data, { relay: "localhost:4499" }), /Turn off/);
  assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
});

it("isolates hostnames and certificates by control address even with the same assigned hostname", (t) => {
  const data = relayData(t);
  const first = "localhost:4498";
  const second = "localhost:4499";
  const hostname = "phone.relay.test";
  const certificate = new X509Certificate(credentials.cert);
  const now = Date.parse(certificate.validFrom) + 100_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  saveServiceOptions(data, { relay: first });
  data.writeJson("service.json", {
    ...readServiceOptions(data),
    relayRegistrations: { [first]: { hostname } },
  });
  const firstEndpoint = `remote-relay/endpoints/${encodeURIComponent(first)}`;
  const secondEndpoint = `remote-relay/endpoints/${encodeURIComponent(second)}`;
  data.writeJson(`${firstEndpoint}/certificate-state.json`, { hostname });
  writeFileSync(data.path(firstEndpoint, "certificate.pem"), credentials.cert);
  writeFileSync(data.path("remote-relay/certificate-key.pem"), credentials.key);
  saveServiceOptions(data, { relay: first });
  assert.equal(existsSync(data.path(firstEndpoint, "certificate.pem")), true);
  saveServiceOptions(data, { relay: second });
  assert.equal(readServiceOptions(data).relayRegistrations[second], undefined);
  data.writeJson(`${secondEndpoint}/certificate-state.json`, {
    hostname,
    directory: "https://acme-v02.api.letsencrypt.org/directory",
    failures: 1,
    validationFailures: 0,
    retryAt: now + 600_000,
  });
  const web = new RemoteRelay(
    data,
    true,
    createServer(),
    new RequestTrust(undefined),
    (connection) => {
      connection.connecting();
      connection.registered(hostname);
      return () => {};
    },
  );
  t.after(() => web.close());
  assert.equal(web.access.customHostname, undefined);
  web.start();
  assert.equal(web.state.status, "missing-certificate");
  assert.equal("certificate" in web.state && web.state.certificate.issuing, false);
  assert.equal(existsSync(data.path(secondEndpoint, "certificate.pem")), false);
  assert.deepEqual(readFileSync(data.path(firstEndpoint, "certificate.pem")), credentials.cert);
  assert.equal(existsSync(data.path(firstEndpoint, "certificate-state.json")), true);
  web.close();
  saveServiceOptions(data, { relay: first });
  assert.equal(web.access.customHostname, hostname);
  web.start();
  const state = web.access.state;
  assert.equal(state.status, "connected");
  assert.equal("certificate" in state && state.certificate.issuing, false);
});
