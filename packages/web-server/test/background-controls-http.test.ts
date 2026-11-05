import assert from "node:assert/strict";
import { it } from "node:test";
import { readServiceOptions } from "../src/background-service.ts";
import { connectServer } from "./support/connect-devices.ts";
import { fakeServe } from "./support/serve-control.ts";
import { networkAccessUrls } from "../src/network-urls.ts";

it("saves LAN options then exits 42, and calls the Launcher's autostart contract", async (t) => {
  const cli = fakeServe(t);
  const server = await connectServer(
    t,
    { ...cli.environment, CODEXHOST_NPM_NODE_PATH: "/n", CODEXHOST_NPM_LAUNCHER_PATH: "/w" },
    true,
  );
  assert.deepEqual((await server.access()).background, {
    lan: false,
    autostart: { status: "off" },
  });
  const initial = await server.access();
  assert.deepEqual(initial.networkUrls, []);
  assert.deepEqual(initial.directCandidates, networkAccessUrls("0.0.0.0", 4474));
  const secret = (await server.access()).secret;
  for (const method of ["codexhost/lanSet", "codexhost/autostartSet"] as const) {
    for (const headers of [{ host: "phone.example" }, { "x-forwarded-for": "198.51.100.1" }]) {
      const rejected = await server.call(
        method,
        { enabled: true },
        { authorization: `Bearer ${secret}`, ...headers },
      );
      assert.equal(rejected.error.code, "auth/local-access-required");
    }
    assert.equal((await server.call(method, { enabled: "true" })).ok, false);
  }
  assert.equal(server.autostart(), "off");
  assert.equal(readServiceOptions(server.data).host, "127.0.0.1");
  assert.deepEqual((await server.call("codexhost/autostartSet", { enabled: true })).value, {
    status: "on",
  });
  assert.equal(server.autostart(), "on");
  // Only registration gets npm's entrypoint; the Web environment terminals inherit does not.
  assert.deepEqual(server.launcherEnv("on"), { node: "/n", wrapper: "/w" });
  assert.deepEqual(server.launcherEnv("status"), {});
  assert.deepEqual((await server.call("codexhost/autostartSet", { enabled: false })).value, {
    status: "off",
  });
  server.setAutostart("invalid executable missing");
  assert.deepEqual((await server.access()).background?.autostart, {
    status: "invalid",
    reason: "executable missing",
  });
  server.failAutostart("systemd user service unavailable");
  const failed = await server.call("codexhost/autostartSet", { enabled: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, "systemd user service unavailable");
  server.setAutostart("off");
  assert.deepEqual((await server.call("codexhost/lanSet", { enabled: false })).value, {
    changed: false,
  });
  assert.deepEqual(server.exits, []);
  assert.deepEqual((await server.call("codexhost/lanSet", { enabled: true })).value, {
    changed: true,
  });
  assert.equal(readServiceOptions(server.data).host, "0.0.0.0");
  for (let i = 0; !server.restarted() && i < 100; i++)
    await new Promise((done) => setTimeout(done, 50));
  assert.ok(server.restarted());
  await server.restarted();
  assert.deepEqual(server.exits, [42]);
  assert.equal((await server.access()).background?.lan, true);
  assert.deepEqual((await server.access()).networkUrls, initial.directCandidates);
  assert.equal((await server.access()).secret, secret);
  assert.deepEqual(cli.mutations(), []);
});

it("does not expose background controls in foreground mode", async (t) => {
  const cli = fakeServe(t);
  const server = await connectServer(t, cli.environment);
  assert.equal((await server.access()).background, undefined);
  assert.equal((await server.access()).directCandidates, undefined);
  for (const method of ["codexhost/lanSet", "codexhost/autostartSet"] as const)
    assert.equal(
      (await server.call(method, { enabled: true })).error.code,
      "web/background-required",
    );
  assert.equal(readServiceOptions(server.data).host, "127.0.0.1");
  assert.equal(server.autostart(), "off");
});
