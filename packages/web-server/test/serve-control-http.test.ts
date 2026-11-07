import assert from "node:assert/strict";
import { it } from "node:test";
import { connectServer } from "./support/connect-devices.ts";
import { defined } from "./support/defined.ts";
import { fakeServe } from "./support/serve-control.ts";
import { serveStatus, SERVE_HOST } from "./support/tailscale.ts";

it("confirms Serve against fresh state, verifies writes, preserves other paths and rejects remote callers", async (t) => {
  const cli = fakeServe(t);
  const server = await connectServer(t, cli.environment);
  const set = (enabled: boolean, headers = {}) =>
    server.call("codexhost/tailscaleServeSet", { enabled }, headers);
  assert.equal((await server.access()).tailscale.status, "not-serving");
  cli.set(serveStatus(3000));
  const occupied = (await set(true)).value;
  assert.deepEqual(occupied.state, { status: "occupied", target: "http://127.0.0.1:3000" });
  assert.ok(occupied.error);
  assert.deepEqual(cli.mutations(), []);
  assert.ok((await set(false)).value.error);
  assert.deepEqual(cli.mutations(), []);

  cli.set({}, { noop: true });
  const unchanged = (await set(true)).value;
  assert.equal(unchanged.state.status, "not-serving");
  assert.match(defined(unchanged.error), /did not take effect/);
  cli.set({}, { failure: "permission denied" });
  assert.match(defined((await set(true)).value.error), /permission denied/);

  cli.set();
  assert.deepEqual((await set(true)).value, {
    state: { status: "serving", url: `https://${SERVE_HOST}/`, funnel: false },
  });
  const access = await server.access();
  assert.equal(access.networkUrls[0]?.url, `https://${SERVE_HOST}/`);
  const before = cli.mutations();
  for (const headers of [
    { host: "phone.example" },
    { "x-forwarded-for": "100.64.0.1" },
    { "x-forwarded-host": "127.0.0.1" },
  ]) {
    for (const enabled of [true, false]) {
      const result = await set(enabled, { authorization: `Bearer ${access.secret}`, ...headers });
      assert.equal(result.error.code, "auth/local-access-required");
      assert.equal(result.error.details.url, "http://127.0.0.1:4474");
    }
  }
  assert.deepEqual(cli.mutations(), before);
  const other = { Proxy: "http://127.0.0.1:3000" };
  cli.set({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${SERVE_HOST}:443`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:4474" }, "/other": other },
      },
      [`${SERVE_HOST}:8443`]: { Handlers: { "/": other } },
    },
  });
  assert.equal((await set(false)).value.error, undefined);
  assert.deepEqual(cli.read(), {
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${SERVE_HOST}:443`]: { Handlers: { "/other": other } },
      [`${SERVE_HOST}:8443`]: { Handlers: { "/": other } },
    },
  });
  assert.equal(cli.mutations().at(-1), "serve --https=443 --set-path=/ off");
  // Another HTTPS port forwarding here is preserved too, and is not a failed removal.
  const here = { Proxy: "http://127.0.0.1:4474" };
  cli.set({
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${SERVE_HOST}:443`]: { Handlers: { "/": here } },
      [`${SERVE_HOST}:8443`]: { Handlers: { "/": here, "/other": other } },
    },
  });
  assert.deepEqual((await set(false)).value, {
    state: { status: "serving", url: `https://${SERVE_HOST}:8443/`, funnel: false },
  });
  assert.deepEqual(cli.read().Web[`${SERVE_HOST}:8443`].Handlers, { "/": here, "/other": other });
  assert.equal((await set(false)).value.error, undefined);
  assert.equal(cli.mutations().at(-1), "serve --https=8443 --set-path=/ off");
  assert.deepEqual(cli.read().Web[`${SERVE_HOST}:8443`].Handlers, { "/other": other });
  assert.equal((await set(true)).value.error, undefined);
  const retained = cli.read();
  const writes = cli.mutations();
  await server.stop();
  assert.deepEqual(cli.read(), retained);
  assert.deepEqual(cli.mutations(), writes);
});
