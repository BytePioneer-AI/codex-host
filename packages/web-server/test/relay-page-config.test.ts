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
  assert.equal(web.access.hostname, hostname);
  assert.equal(saveServiceOptions(data, { relay: OFFICIAL_RELAY_HOST }), false);
  saveServiceOptions(data, { port: "4401" });
  assert.equal(readServiceOptions(data).relayKind, undefined);
  assert.equal(readServiceOptions(data).relayHostname, hostname);
  assert.equal(connections.length, 0); // Reading legacy settings does not trigger registration.
  web.start(); // Normal process startup needs no disable/re-enable or new registration inputs.
  assert.equal(web.access.state.status, "connected");
  assert.equal(web.access.kind, "official");
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.host, OFFICIAL_RELAY_HOST);
  assert.equal(connections[0]?.name, "alice");
  assert.equal(connections[0]?.invite, "invite-code");
  assert.deepEqual(readFileSync(data.path("remote-relay/certificate.pem")), credentials.cert);
  assert.deepEqual(readFileSync(data.path("remote-relay/certificate-key.pem")), credentials.key);
  assert.deepEqual(readFileSync(data.path("remote-relay/certificate-state.json")), record);
  assert.equal(web.access.hostname, hostname);
  assert.equal(connections.length, 1);
  assert.equal(
    relayKind({ relayHost: OFFICIAL_RELAY_HOST, relayKind: "self-hosted" }),
    "self-hosted",
  );
  const fresh = relayData(t);
  saveServiceOptions(fresh, { relay: OFFICIAL_RELAY_HOST });
  assert.equal(relayKind(readServiceOptions(fresh)), "official");
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
  web.setEnabled(false);
  data.writeJson("service.json", { ...readServiceOptions(data), relayHostname: "old.example.com" });
  writeFileSync(data.path("remote-relay/certificate.pem"), "old certificate");
  data.writeJson("remote-relay/certificate-state.json", { hostname: "old.example.com" });
  web.setEnabled(false, undefined, { kind: "self-hosted", host: "relay.example.com" });
  assert.equal(web.access.hostname, undefined);
  assert.equal(existsSync(data.path("remote-relay/certificate.pem")), false);
  assert.equal(existsSync(data.path("remote-relay/certificate-state.json")), false);
  assert.equal(readServiceOptions(data).relayInvite, undefined);
  assert.deepEqual(readFileSync(data.path("remote-relay/identity.pem")), identity);
  web.setEnabled(true, { name: "alice", invite: "must-not-leak" });
  assert.equal(connections[1]?.host, "relay.example.com");
  assert.equal(connections[1]?.name, "");
  assert.equal(connections[1]?.invite, "");
  web.setEnabled(false);
  web.setEnabled(true, undefined, { kind: "official" });
  assert.equal(connections[2]?.host, OFFICIAL_RELAY_HOST);
  assert.equal(connections[2]?.invite, "");
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
  assert.equal(readServiceOptions(data).relayHostname, "alice.chost.dev");
  saveServiceOptions(data, { relay: "" });
  assert.equal(readServiceOptions(data).relayKind, "official");
  assert.equal(readServiceOptions(data).relayHost, undefined);
  data.writeJson("service.json", { relayHost: "localhost:4498", relayEnabled: true });
  assert.throws(() => saveServiceOptions(data, { relay: "localhost:4499" }), /Turn off/);
  assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
});

it("same endpoint preserves certificates; changing a CLI endpoint removes them", (t) => {
  const data = relayData(t);
  saveServiceOptions(data, { relay: "localhost:4498" });
  data.writeJson("service.json", { ...readServiceOptions(data), relayHostname: "same.relay.test" });
  // Both relays could assign the same DNS suffix; domain checking alone is not isolation.
  data.writeJson("remote-relay/certificate-state.json", { hostname: "same.relay.test" });
  writeFileSync(data.path("remote-relay/certificate.pem"), "old certificate");
  saveServiceOptions(data, { relay: "localhost:4498" });
  assert.equal(existsSync(data.path("remote-relay/certificate.pem")), true);
  saveServiceOptions(data, { relay: "localhost:4499" });
  assert.equal(existsSync(data.path("remote-relay/certificate.pem")), false);
  assert.equal(existsSync(data.path("remote-relay/certificate-state.json")), false);
  assert.equal(readServiceOptions(data).relayHostname, undefined);
});
