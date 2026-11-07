import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import type { WebAccessState, WebRelayState } from "@codexhost/shared-contracts";
import { readServiceOptions, saveServiceOptions } from "../src/background-service.ts";
import { relayIdentity } from "../src/remote-relay/identity.ts";
import { DataDir } from "../src/store.ts";
import { startServer } from "./support/server.ts";
import { acmeServer } from "./support/acme-server.ts";
import { certPath, startRelay, until } from "./support/relay.ts";

function fixture(t: TestContext) {
  const data = new DataDir(mkdtempSync(join(tmpdir(), "relay-settings-")));
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  return data;
}

it("creates a private identity, reuses it, and derives a new ID after deletion", (t) => {
  const data = fixture(t);
  const first = relayIdentity(data);
  assert.match(first.id, /^[a-z2-7]{26}$/);
  const file = data.path("remote-relay/identity.pem");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(relayIdentity(new DataDir(data.root)).id, first.id);
  rmSync(file);
  assert.notEqual(relayIdentity(data).id, first.id);
});

async function server(
  t: TestContext,
  data: DataDir,
  authenticated = true,
  environment: NodeJS.ProcessEnv = {},
) {
  const login = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data.root],
      { authenticated, environment: { HTTPS_PROXY: "", https_proxy: "", ...environment } },
    ),
  );
  const token = login.searchParams.get("token");
  async function call<T = WebRelayState>(method: string, args = {}, headers = {}) {
    return new Promise<{ value: T; error: { code: string } }>((resolve, reject) => {
      const req = request(
        new URL(`/api/${method}`, login),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            ...headers,
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(JSON.parse(body).result));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ type: "client-request", rpcId: "test", method, payload: { args } }));
    });
  }
  return { call };
}

it("saves the switch without restarting, rejects remote changes, and keeps both relay choices", async (t) => {
  const data = fixture(t);
  saveServiceOptions(data, { relay: "localhost:4498" });
  assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
  const { call } = await server(t, data);
  const access = (await call<WebAccessState>("codexhost/accessTokenGet")).value;
  assert.deepEqual(access.relay, {
    state: { status: "off" },
    kind: "self-hosted",
    enabled: false,
    officialHost: "relay.chost.dev",
    customHost: "localhost:4498",
  });
  for (const headers of [{ host: "phone.example" }, { "x-forwarded-for": "127.0.0.1" }]) {
    const result = await call(
      "codexhost/relaySet",
      { enabled: true },
      { authorization: `Bearer ${access.secret}`, ...headers },
    );
    assert.equal(result.error.code, "auth/local-access-required");
    assert.equal(readServiceOptions(data).relayEnabled, false);
  }
  assert.equal((await call("codexhost/relaySet", { enabled: true })).value.status, "connecting");
  assert.equal(readServiceOptions(data).relayEnabled, true);
  assert.ok(existsSync(data.path("remote-relay/identity.pem")));
  for (const args of [
    { enabled: true, kind: "official" },
    { enabled: false, kind: "self-hosted", host: "new.example.com" },
  ]) {
    assert.equal((await call("codexhost/relaySet", args)).error.code, "relay/enabled");
    assert.equal(readServiceOptions(data).relayEnabled, true);
    assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
  }
  assert.equal((await call("codexhost/relaySet", { enabled: false })).value.status, "off");
  assert.equal(
    (await call<WebAccessState>("codexhost/accessTokenGet")).value.secret,
    access.secret,
  );
  saveServiceOptions(data, { relay: "" });
  const cleared = await server(t, data);
  assert.equal(
    (await cleared.call<WebAccessState>("codexhost/accessTokenGet")).value.relay?.customHost,
    undefined,
  );
  assert.equal(
    (await cleared.call("codexhost/relaySet", { enabled: true })).error.code,
    "relay/not-configured",
  );
});

it("validates address names per relay kind and never sends invitations to a self-hosted relay", async (t) => {
  const requests: { name?: string; invite?: string }[] = [];
  const relay = await startRelay(t, 25, {
    check: (request) => {
      requests.push(request);
      return { name: "alice" };
    },
  });
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "test CA unavailable" });
    return true;
  });
  const data = fixture(t);
  saveServiceOptions(data, { relay: `localhost:${relay.port}` });
  const { call } = await server(t, data, true, {
    NODE_EXTRA_CA_CERTS: certPath,
    CODEXHOST_RELAY_ACME_DIRECTORY: ca.directory,
  });
  for (const name of ["abc", "ALICE", "a-bc", "a".repeat(21)]) {
    const result = await call("codexhost/relaySet", {
      enabled: true,
      kind: "official",
      name,
      invite: "code",
    });
    assert.ok(result.error);
    assert.equal(readServiceOptions(data).relayEnabled, false);
  }
  for (const name of ["a.b", "-name", "name-", "a".repeat(64)]) {
    const result = await call("codexhost/relaySet", { enabled: true, kind: "self-hosted", name });
    assert.ok(result.error);
  }
  await call("codexhost/relaySet", {
    enabled: true,
    kind: "self-hosted",
    name: "my-computer",
    invite: "code",
  });
  const host = `localhost:${relay.port}`;
  await until(
    () => readServiceOptions(data).relayRegistrations[host]?.hostname === "alice.relay.test",
  );
  assert.equal(requests[0]?.name, "my-computer");
  assert.equal(requests[0]?.invite, undefined);
  assert.equal(
    (await call<WebAccessState>("codexhost/accessTokenGet")).value.relay?.customHostname,
    "alice.relay.test",
  );
  await call("codexhost/relaySet", { enabled: false });
  assert.equal(readServiceOptions(data).relayRegistrations[host]?.name, "my-computer");
  assert.equal(readServiceOptions(data).relayRegistrations[host]?.invite, undefined);
});

it("does not create an identity or connect with --no-auth even when enabled", async (t) => {
  const data = fixture(t);
  data.writeJson("service.json", { relayHost: "localhost:4498", relayEnabled: true });
  const { call } = await server(t, data, false);
  for (const enabled of [true, false])
    assert.equal((await call("codexhost/relaySet", { enabled })).error.code, "auth/disabled");
  assert.equal(existsSync(data.path("remote-relay/identity.pem")), false);
});

it("defaults to official and saves validated self-hosted settings live through the local RPC", async (t) => {
  const data = fixture(t);
  const { call } = await server(t, data);
  const initial = (await call<WebAccessState>("codexhost/accessTokenGet")).value;
  assert.equal(initial.relay?.kind, "official");
  assert.equal(initial.relay?.officialHost, "relay.chost.dev");
  assert.equal(initial.relay?.enabled, false);
  assert.equal(existsSync(data.path("remote-relay/identity.pem")), false);
  for (const host of [
    "https://relay.example.com",
    "relay.example.com:443",
    "127.0.0.1",
    "a..com",
    "-relay.example.com",
    "relay.example.com/path",
    "a_b.example.com",
    "relay.example.com ",
  ]) {
    const result = await call("codexhost/relaySet", { enabled: false, kind: "self-hosted", host });
    assert.ok(result.error, host);
    assert.equal(readServiceOptions(data).relayHost, undefined);
  }
  const remote = await call(
    "codexhost/relaySet",
    { enabled: false, kind: "self-hosted", host: "relay.example.com" },
    { host: "phone.example", authorization: `Bearer ${initial.secret}` },
  );
  assert.equal(remote.error.code, "auth/local-access-required");
  assert.equal(
    (
      await call("codexhost/relaySet", {
        enabled: false,
        kind: "self-hosted",
        host: "RELAY.example.com",
      })
    ).value.status,
    "off",
  );
  assert.equal(readServiceOptions(data).relayHost, "relay.example.com");
  assert.equal(
    (await call<WebAccessState>("codexhost/accessTokenGet")).value.secret,
    initial.secret,
  );
  await call("codexhost/relaySet", { enabled: false, kind: "official" });
  assert.equal(readServiceOptions(data).relayHost, "relay.example.com");
  assert.equal(
    (await call<WebAccessState>("codexhost/accessTokenGet")).value.relay?.kind,
    "official",
  );
});
