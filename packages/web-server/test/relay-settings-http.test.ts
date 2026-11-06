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

async function server(t: TestContext, data: DataDir, authenticated = true) {
  const login = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data.root],
      { authenticated, environment: { HTTPS_PROXY: "", https_proxy: "" } },
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

it("saves the switch without restarting, rejects remote changes, and hides cleared configuration", async (t) => {
  const data = fixture(t);
  saveServiceOptions(data, { relay: "localhost:4498" });
  assert.equal(readServiceOptions(data).relayHost, "localhost:4498");
  const { call } = await server(t, data);
  const access = (await call<WebAccessState>("codexhost/accessTokenGet")).value;
  assert.deepEqual(access.relay, {
    state: { status: "off" },
    identityPath: data.path("remote-relay/identity.pem"),
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
  assert.equal((await call("codexhost/relaySet", { enabled: false })).value.status, "off");
  assert.equal(
    (await call<WebAccessState>("codexhost/accessTokenGet")).value.secret,
    access.secret,
  );
  saveServiceOptions(data, { relay: "" });
  const cleared = await server(t, data);
  assert.equal(
    (await cleared.call<WebAccessState>("codexhost/accessTokenGet")).value.relay,
    undefined,
  );
  assert.equal(
    (await cleared.call("codexhost/relaySet", { enabled: true })).error.code,
    "relay/not-configured",
  );
});

it("does not create an identity or connect with --no-auth even when enabled", async (t) => {
  const data = fixture(t);
  data.writeJson("service.json", { relayHost: "localhost:4498", relayEnabled: true });
  const { call } = await server(t, data, false);
  for (const enabled of [true, false])
    assert.equal((await call("codexhost/relaySet", { enabled })).error.code, "auth/disabled");
  assert.equal(existsSync(data.path("remote-relay/identity.pem")), false);
});
