import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import {
  decodeHarnessPluginRoute,
  harnessPreferencePatchSchema,
  HARNESS_PREFERENCES_GET_METHOD,
  HARNESS_PREFERENCES_PATCH_METHOD,
} from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { WebHarnessPreferences } from "../src/harness-preferences.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

function setup(t: TestContext, preferencesAvailable = true) {
  const root = mkdtempSync(join(tmpdir(), "ch-permissions-"));
  const host = new FakeChHost();
  host.inspection.permissionModes = {
    modes: [
      { id: "read-only", label: "Read only" },
      { id: "workspace-write", label: "Auto" },
      { id: "danger-full-access", label: "Full access" },
    ],
    defaultModeId: "workspace-write",
  };
  const store = new HarnessPreferencesStore(join(root, "host"));
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (preferencesAvailable && method === HARNESS_PREFERENCES_GET_METHOD)
      return (await store.get("external")) as T;
    if (preferencesAvailable && method === HARNESS_PREFERENCES_PATCH_METHOD)
      return (await store.patch(harnessPreferencePatchSchema.parse(params))) as T;
    if (method === "codexhost/harness/plugins/list")
      return {
        plugins: [
          { id: "fake", name: "Target Harness", version: "1" },
          { id: "other", name: "Other Harness", version: "1" },
        ],
      } as T;
    const result = await request<T>(method, params);
    if (method === "thread/start") {
      const { thread } = result as { thread: { id: string } };
      const mode = decodeHarnessPluginRoute(params.model)?.permissionModeId;
      if (mode) host.modes.set(thread.id, mode);
    }
    if (method === "codexhost/thread/inspect" && !host.modes.has(String(params.threadId)))
      delete (result as { effectivePermissionModeId?: string }).effectivePermissionModeId;
    return result;
  };
  const events = new EventHub(root);
  const preferences = new WebHarnessPreferences(host, events);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(join(root, "web")), root),
    events,
    undefined,
    undefined,
    undefined,
    preferences,
  );
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  sessions.registerCommands(rpc);
  t.after(async () => {
    await sessions.close();
    await preferences.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async <T>(method: string, args: object): Promise<T> => {
    const result = await rpc.dispatch(method, { args });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const controls = async (sessionId: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await call<{
        values: { permissions: { currentValue: string }; nativePermissions?: unknown };
      }>("session/projections", { request: { sessionId } });
      if (result.values.nativePermissions) return result.values;
      await setTimeout(1);
    }
    throw new Error("Native permission controls did not load");
  };
  return { root, host, store, preferences, sessions, call, controls };
}

for (const preferred of [undefined, "removed-mode", "danger-full-access"])
  it(`submits the displayed permission after switching Harness with preference ${preferred}`, async (t) => {
    const f = setup(t);
    if (preferred)
      await f.preferences.remember("fake", {
        model: { id: "native" },
        permissionModeId: preferred,
      });
    const { sessionId } = await f.call<{ sessionId: string }>("session/create", {
      request: { cwd: f.root },
    });
    for (const provider of ["other", "fake"])
      await f.call("session/selectModel", { request: { sessionId, provider, model: "native" } });
    const expected = preferred === "danger-full-access" ? preferred : "workspace-write";
    assert.equal((await f.controls(sessionId)).permissions.currentValue, expected);
    assert.equal(
      (await f.store.get()).values.newThread?.byHarness.fake?.permissionModeId,
      expected,
    );
    await f.call("session/prompt", {
      request: { sessionId, content: [{ type: "text", text: "isolated fake prompt" }] },
    });
    const start = f.host.requests.find(({ method }) => method === "thread/start");
    assert.ok(start);
    assert.equal(decodeHarnessPluginRoute(start.params.model)?.permissionModeId, expected);
    assert.equal((await f.controls(sessionId)).permissions.currentValue, expected);
  });

it("uses the target's default permission when preference RPCs are unavailable", async (t) => {
  const f = setup(t, false);
  const { sessionId } = await f.call<{ sessionId: string }>("session/create", {
    request: { cwd: f.root },
  });
  for (const provider of ["other", "fake"])
    await f.call("session/selectModel", { request: { sessionId, provider, model: "native" } });
  await f.call("session/prompt", {
    request: { sessionId, content: [{ type: "text", text: "isolated fake prompt" }] },
  });
  const start = f.host.requests.find(({ method }) => method === "thread/start");
  assert.ok(start);
  assert.equal(decodeHarnessPluginRoute(start.params.model)?.permissionModeId, "workspace-write");
});

it("does not display the catalog default for a draft with no permission selection", async (t) => {
  const f = setup(t);
  await f.sessions.prepareDraft(
    { sessionId: "inherited", cwd: f.root },
    { selection: { provider: "fake", model: "native" } },
  );
  assert.equal((await f.controls("inherited")).permissions.currentValue, "");
  await f.call("session/prompt", {
    request: {
      sessionId: "inherited",
      content: [{ type: "text", text: "use native permissions" }],
    },
  });
  const start = f.host.requests.find(({ method }) => method === "thread/start");
  assert.ok(start);
  assert.equal(decodeHarnessPluginRoute(start.params.model)?.permissionModeId, undefined);
  assert.equal((await f.controls("inherited")).permissions.currentValue, "");
});

it("clears stale permission state when the Host no longer reports an effective mode", async (t) => {
  const f = setup(t);
  f.host.add("existing", f.root);
  f.host.modes.set("existing", "danger-full-access");
  assert.equal((await f.controls("existing")).permissions.currentValue, "danger-full-access");
  f.host.modes.delete("existing");
  const row = f.host.threads.get("existing");
  assert.ok(row);
  row.status = { type: "active" };
  await f.call("session/projections", { request: { sessionId: "existing" } });
  await setTimeout(0);
  assert.equal((await f.controls("existing")).permissions.currentValue, "");
});

it("preserves a real Harness mode whose native ID is default", async (t) => {
  const f = setup(t);
  f.host.inspection.permissionModes = {
    modes: [{ id: "default", label: "Native default" }],
    defaultModeId: "default",
  };
  f.host.add("existing", f.root);
  f.host.modes.set("existing", "default");
  assert.equal((await f.controls("existing")).permissions.currentValue, "default");
});
