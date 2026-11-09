/** UI extension management is restricted to authenticated local requests. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";

import { webUiExtensionsStateSchema } from "@codexhost/shared-contracts";

import type { RequestAuth } from "../src/auth.ts";
import { DataDir } from "../src/store.ts";
import { RpcRegistry } from "../src/transport.ts";
import { registerUiExtensionRpc } from "../src/ui-extension-rpc.ts";
import { WebUiExtensions } from "../src/ui-extensions.ts";

const PACKAGE = "@test/dsh-rpc-theme";
const SPEC = `${PACKAGE}@1.0.0`;
const PREFIX = "codexhost/uiExtensions/";
const REGISTRY = "ui-extensions/installed.json";
const LOCAL: RequestAuth = { credential: "local", local: true, release: () => undefined };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-ui-extension-rpc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  let installCalls = 0;
  let selectedRegistry: string | undefined;
  let port = 4400;
  const store = new WebUiExtensions(data, {
    installPackage: async (directory, _spec, registry) => {
      installCalls++;
      selectedRegistry = registry;
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ dependencies: { [PACKAGE]: "1.0.0" } }),
      );
      const packageDir = join(directory, "node_modules", PACKAGE);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: PACKAGE, version: "1.0.0" }),
      );
    },
    validate: () => undefined,
  });
  const rpc = new RpcRegistry();
  registerUiExtensionRpc(rpc, store, { port: () => port });
  return {
    data,
    store,
    rpc,
    installCalls: () => installCalls,
    selectedRegistry: () => selectedRegistry,
    setPort: (value: number) => {
      port = value;
    },
  };
}

it("rejects every management RPC without local authentication and leaves installed state unchanged", async (t) => {
  const f = fixture(t);
  await f.store.install(SPEC);
  await f.store.setEnabled(PACKAGE, true);
  const saved = readFileSync(f.data.path(REGISTRY), "utf8");
  const directories = readdirSync(f.data.path("ui-extensions", "packages"));
  const state = f.store.state();
  const rejectedAuth: Array<RequestAuth | undefined> = [
    undefined,
    { credential: "named-token", local: false, release: () => undefined },
    { credential: "local", local: false, release: () => undefined },
  ];
  for (const auth of rejectedAuth) {
    for (const [method, args] of [
      ["list", {}],
      ["install", { spec: SPEC }],
      ["setEnabled", { id: PACKAGE, enabled: false }],
      ["remove", { id: PACKAGE }],
    ] as const) {
      const result = await f.rpc.dispatch(PREFIX + method, { args }, auth);
      assert.equal(result.ok, false, method);
      if (!result.ok) {
        assert.equal(result.error.code, "auth/local-access-required");
        assert.deepEqual(result.error.details, { url: "http://127.0.0.1:4400" });
      }
      assert.deepEqual(f.store.state(), state);
      assert.equal(readFileSync(f.data.path(REGISTRY), "utf8"), saved);
      assert.deepEqual(readdirSync(f.data.path("ui-extensions", "packages")), directories);
    }
  }
  assert.equal(f.installCalls(), 1);
});

it("returns the current listening port in local-access rejections", async (t) => {
  const f = fixture(t);
  f.setPort(54721);
  const result = await f.rpc.dispatch(PREFIX + "install", { args: { spec: SPEC, local: true } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "auth/local-access-required");
    assert.deepEqual(result.error.details, { url: "http://127.0.0.1:54721" });
  }
  assert.equal(f.installCalls(), 0);
  assert.deepEqual(f.store.state().extensions, []);
});

it("allows a local authenticated request to list, install, enable, disable, and remove", async (t) => {
  const f = fixture(t);
  const call = async (method: string, args: Record<string, unknown> = {}) => {
    const result = await f.rpc.dispatch(PREFIX + method, { args }, LOCAL);
    assert.ok(result.ok, JSON.stringify(result));
    return webUiExtensionsStateSchema.parse(result.value);
  };
  assert.deepEqual((await call("list")).extensions, []);
  const installed = await call("install", { spec: SPEC });
  assert.equal(installed.extensions[0]?.id, PACKAGE);
  assert.deepEqual(installed.extensions[0]?.enabledTargets, []);
  assert.deepEqual(
    (await call("setEnabled", { id: PACKAGE, enabled: true })).extensions[0]?.enabledTargets,
    ["web"],
  );
  assert.deepEqual(await call("list"), f.store.state());
  assert.deepEqual(
    (await call("setEnabled", { id: PACKAGE, enabled: false })).extensions[0]?.enabledTargets,
    [],
  );
  assert.deepEqual((await call("remove", { id: PACKAGE })).extensions, []);
  assert.deepEqual(readdirSync(f.data.path("ui-extensions", "packages")), []);
  assert.equal(f.installCalls(), 1);
});

it("forwards the selected installation registry for a bare npm package name", async (t) => {
  const f = fixture(t);
  const result = await f.rpc.dispatch(
    PREFIX + "install",
    {
      args: { spec: PACKAGE, registry: "https://NPM.example.com/custom" },
    },
    LOCAL,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(f.selectedRegistry(), "https://npm.example.com/custom/");
  assert.equal(f.store.state().extensions[0]?.version, "1.0.0");
});

it("rejects invalid management payloads before altering persistent state", async (t) => {
  const f = fixture(t);
  await f.store.install(SPEC);
  const saved = readFileSync(f.data.path(REGISTRY), "utf8");
  const state = f.store.state();
  for (const [method, args] of [
    ["install", {}],
    ["install", { spec: "   " }],
    ["install", { spec: 1 }],
    ["install", { spec: SPEC, enabled: true }],
    ["install", { spec: SPEC, registry: "file:///tmp/registry" }],
    ["install", { spec: SPEC, registry: "https://user:password@registry.example.com" }],
    ["install", { spec: SPEC, registry: "https://registry.example.com?token=value" }],
    ["install", { spec: SPEC, registry: "https://registry.example.com#fragment" }],
    ["install", { spec: SPEC, registry: "invalid" }],
    ["install", { spec: SPEC, registry: 1 }],
    ["setEnabled", { id: PACKAGE }],
    ["setEnabled", { id: PACKAGE, enabled: "true" }],
    ["setEnabled", { id: "../../outside", enabled: true }],
    ["setEnabled", { id: PACKAGE, enabled: true, target: "desktop" }],
    ["remove", {}],
    ["remove", { id: "../../outside" }],
    ["remove", { id: PACKAGE, force: true }],
  ] as const) {
    const result = await f.rpc.dispatch(PREFIX + method, { args }, LOCAL);
    assert.equal(result.ok, false, `${method}: ${JSON.stringify(args)}`);
    if (!result.ok) assert.equal(result.error.code, "extensions/change-failed");
    assert.deepEqual(f.store.state(), state);
    assert.equal(readFileSync(f.data.path(REGISTRY), "utf8"), saved);
  }
  assert.equal(f.installCalls(), 1);
});
