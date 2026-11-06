import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { it, type TestContext } from "node:test";
import type { RelayOptions, RegistrationRequest } from "@codexhost/remote-relay";
import { readServiceOptions, saveServiceOptions } from "../src/background-service.ts";
import { RemoteRelay } from "../src/remote-relay/state.ts";
import { RequestTrust } from "../src/request-trust.ts";
import { acmeServer } from "./support/acme-server.ts";
import { delay, relayData, startRelay, until } from "./support/relay.ts";

async function fixture(t: TestContext, check: NonNullable<RelayOptions["check"]>) {
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "test CA unavailable" });
    return true;
  });
  const previous = {
    directory: process.env.CODEXHOST_RELAY_ACME_DIRECTORY,
    upper: process.env.HTTPS_PROXY,
    lower: process.env.https_proxy,
  };
  process.env.CODEXHOST_RELAY_ACME_DIRECTORY = ca.directory;
  process.env.HTTPS_PROXY = "";
  process.env.https_proxy = "";
  t.after(() => {
    for (const [key, value] of [
      ["CODEXHOST_RELAY_ACME_DIRECTORY", previous.directory],
      ["HTTPS_PROXY", previous.upper],
      ["https_proxy", previous.lower],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
  const relay = await startRelay(t, 25, { check });
  const data = relayData(t);
  const host = `localhost:${relay.port}`;
  saveServiceOptions(data, { relay: host });
  const web = new RemoteRelay(data, host, true, createServer(), new RequestTrust(undefined));
  t.after(() => web.close());
  return { relay, data, web };
}

it("submits and saves name and invite, remembers the hostname across disable and reconnect", async (t) => {
  const requests: RegistrationRequest[] = [];
  const f = await fixture(t, (request) => {
    requests.push(request);
    return { name: "alice" };
  });
  f.web.setEnabled(true, { name: "alice", invite: "invite-code" });
  await until(() => f.web.access?.hostname === "alice.relay.test");
  assert.equal(requests[0]?.name, "alice");
  assert.equal(requests[0]?.invite, "invite-code");
  assert.match(requests[0]?.id ?? "", /^[a-z2-7]{26}$/);
  assert.ok(requests[0]?.ip);
  assert.equal(readServiceOptions(f.data).relayName, "alice");
  assert.equal(readServiceOptions(f.data).relayInvite, "invite-code");
  assert.equal(readServiceOptions(f.data).relayHostname, "alice.relay.test");
  f.web.setEnabled(false);
  assert.equal(f.web.access?.hostname, "alice.relay.test");
  f.web.setEnabled(true);
  await until(() => requests.length === 2 && f.web.state.status === "missing-certificate");
  assert.equal(requests[1]?.name, "alice");
  assert.equal(requests[1]?.invite, "invite-code");
  assert.equal(requests[0]?.id, requests[1]?.id);
  f.web.setEnabled(false);
  const restarted = new RemoteRelay(
    f.data,
    readServiceOptions(f.data).relayHost,
    true,
    createServer(),
    new RequestTrust(undefined),
  );
  t.after(() => restarted.close());
  assert.equal(restarted.access?.hostname, "alice.relay.test");
});

it("omits empty registration headers and lets check allocate a name", async (t) => {
  let request: RegistrationRequest | undefined;
  const f = await fixture(t, (value) => {
    request = value;
    return { name: "assigned123" };
  });
  f.web.setEnabled(true, { name: "", invite: "" });
  await until(() => f.web.access?.hostname === "assigned123.relay.test");
  assert.equal(request?.name, undefined);
  assert.equal(request?.invite, undefined);
});

for (const reason of ["invite", "name-taken", "banned"] as const) {
  it(`turns off and remembers ${reason} without retrying until enabled again`, async (t) => {
    let checks = 0;
    let allowed = false;
    const f = await fixture(t, () => {
      checks++;
      return allowed ? { name: "alice" } : { reject: reason };
    });
    f.web.setEnabled(true, { name: "alice", invite: "bad" });
    await until(() => f.web.state.status === "off" && f.web.state.reason === reason);
    assert.equal(readServiceOptions(f.data).relayEnabled, false);
    assert.equal(f.web.access?.hostname, undefined);
    assert.equal("reason" in readServiceOptions(f.data), false);
    await delay(1_100);
    assert.equal(checks, 1);
    assert.deepEqual(f.web.state, { status: "off", reason });
    allowed = true;
    f.web.setEnabled(true, { name: "alice", invite: "fixed" });
    assert.deepEqual(f.web.state, { status: "connecting" });
    await until(() => f.web.access?.hostname === "alice.relay.test");
    assert.equal(checks, 2);
    assert.equal(readServiceOptions(f.data).relayEnabled, true);
  });
}

for (const reason of ["invite", "name-taken"] as const) {
  it(`clears a remembered hostname after identity loss and ${reason} rejection`, async (t) => {
    let originalId: string | undefined;
    let newIdentity = false;
    let corrected = false;
    const f = await fixture(t, (request) => {
      originalId ??= request.id;
      newIdentity = request.id !== originalId;
      if (newIdentity && !corrected) return { reject: reason };
      return { name: newIdentity ? "newalice" : "alice" };
    });
    f.web.setEnabled(true, { name: "alice", invite: "used-code" });
    await until(() => f.web.access?.hostname === "alice.relay.test");
    f.web.setEnabled(false);
    rmSync(f.data.path("remote-relay/identity.pem"));
    f.web.setEnabled(true);
    await until(() => f.web.state.status === "off" && f.web.state.reason === reason);
    assert.equal(newIdentity, true);
    assert.equal(readServiceOptions(f.data).relayHostname, undefined);
    assert.equal(f.web.access?.hostname, undefined);
    corrected = true;
    f.web.setEnabled(true, { name: "newalice", invite: "new-code" });
    await until(() => f.web.access?.hostname === "newalice.relay.test");
  });
}

it("only writes a registered hostname when it changes, not on reconnect", async (t) => {
  let name = "alice";
  let registrations = 0;
  const f = await fixture(t, () => {
    registrations++;
    return { name };
  });
  f.web.setEnabled(true);
  await until(() => f.web.access?.hostname === "alice.relay.test");
  const writes = t.mock.method(f.data, "writeJson");
  const serviceWrites = () =>
    writes.mock.calls.filter((call) => call.arguments[0] === "service.json");
  f.relay.disconnect("alice");
  await until(() => registrations === 2 && f.web.state.status === "missing-certificate");
  assert.equal(serviceWrites().length, 0);
  name = "newalice";
  f.relay.disconnect("alice");
  await until(() => f.web.access?.hostname === "newalice.relay.test");
  assert.equal(serviceWrites().length, 1);
});

it("keeps the switch enabled and retries after a full Relay", async (t) => {
  let full = true;
  let checks = 0;
  const f = await fixture(t, () => {
    checks++;
    return full ? { reject: "full" } : { name: "alice" };
  });
  f.web.setEnabled(true);
  await until(() => f.web.state.status === "connecting" && f.web.state.reason === "full");
  assert.equal(readServiceOptions(f.data).relayEnabled, true);
  full = false;
  await until(() => f.web.access?.hostname === "alice.relay.test");
  assert.ok(checks >= 2);
  assert.equal(readServiceOptions(f.data).relayEnabled, true);
});

it(
  "receives a real quota notice, keeps registration, and clears the hint at recovery",
  { timeout: 5_000 },
  async (t) => {
    let checks = 0;
    const f = await fixture(t, () => {
      checks++;
      return { name: "alice", dailyQuota: 100, usedToday: 100 };
    });
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-06T23:59:59Z") });
    f.web.setEnabled(true);
    for (let i = 0; i < 50 && f.web.access?.quotaUntil === undefined; i++) await delay(10);
    assert.equal(f.web.access?.quotaUntil, "2026-11-07T00:00:00.000Z");
    assert.equal(readServiceOptions(f.data).relayEnabled, true);
    assert.equal(readServiceOptions(f.data).relayHostname, "alice.relay.test");
    await delay(1_100);
    assert.equal(f.web.access?.quotaUntil, undefined);
    assert.equal(checks, 1);
    assert.equal(f.web.state.status, "missing-certificate");
  },
);

it("only clears the remembered hostname when the Relay control address changes", (t) => {
  const data = relayData(t);
  data.writeJson("service.json", {
    relayHost: "old.example",
    relayEnabled: false,
    relayName: "alice",
    relayInvite: "invite-code",
    relayHostname: "alice.relay.test",
  });
  assert.equal(saveServiceOptions(data, { relay: "old.example" }), false);
  assert.equal(readServiceOptions(data).relayHostname, "alice.relay.test");
  saveServiceOptions(data, { port: "4497" });
  assert.equal(readServiceOptions(data).relayHostname, "alice.relay.test");
  saveServiceOptions(data, { relay: "new.example" });
  assert.equal(readServiceOptions(data).relayHostname, undefined);
  assert.equal(readServiceOptions(data).relayName, "alice");
  assert.equal(readServiceOptions(data).relayInvite, "invite-code");
  data.writeJson("service.json", {
    ...readServiceOptions(data),
    relayHostname: "alice.new.example",
  });
  saveServiceOptions(data, { relay: "" });
  assert.equal(readServiceOptions(data).relayHostname, undefined);
});
