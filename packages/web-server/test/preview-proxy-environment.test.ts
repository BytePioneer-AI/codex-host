import assert from "node:assert/strict";
import { it } from "node:test";
import { previewLaunch, previewProxyEnvironment } from "../src/preview-launch.ts";

it("resolves the isolated Web environment through the native Launcher", async () => {
  const parent = {
    PATH: process.env.PATH,
    HTTPS_PROXY: "http://127.0.0.1:12345",
    CODEXHOST_RUNTIME_TOKEN: "must-not-reach-preview",
    NODE_OPTIONS: "--import=/unsafe/hook.mjs",
  };
  const original = { ...parent };
  const launch = previewLaunch("/packed", {}, parent);
  const resolved = await previewProxyEnvironment(
    "/native/launcher",
    launch.env,
    async (...args) => {
      assert.deepEqual(args, ["/native/launcher", ["proxy-environment"], launch.env]);
      assert.equal(args[2].CODEXHOST_RUNTIME_TOKEN, undefined);
      assert.equal(args[2].NODE_OPTIONS, undefined);
      return JSON.stringify({
        HTTPS_PROXY: parent.HTTPS_PROXY,
        https_proxy: parent.HTTPS_PROXY,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "localhost,127.0.0.1,::1",
      });
    },
  );
  assert.equal(resolved.NODE_USE_ENV_PROXY, "1");
  assert.equal(resolved.https_proxy, parent.HTTPS_PROXY);
  assert.equal(resolved.PATH, parent.PATH);
  assert.equal(launch.env.NODE_USE_ENV_PROXY, undefined);
  assert.deepEqual(parent, original);
});

it("uses the native decision unchanged for direct connections and explicit opt-outs", async () => {
  for (const overlay of [{}, { NODE_USE_ENV_PROXY: "0" }]) {
    const parent = { HTTPS_PROXY: "", ...overlay };
    const resolved = await previewProxyEnvironment("/native/launcher", parent, async () =>
      JSON.stringify(overlay),
    );
    assert.deepEqual(resolved, parent);
  }
});

it("does not silently start Web with an unresolved network policy", async () => {
  await assert.rejects(
    previewProxyEnvironment("/native/launcher", {}, async () => {
      throw new Error("Native resolver unavailable");
    }),
    /Native resolver unavailable/u,
  );
});
