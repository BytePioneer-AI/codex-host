import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import {
  harnessPreferencePatchSchema,
  HARNESS_PREFERENCES_GET_METHOD,
  HARNESS_PREFERENCES_PATCH_METHOD,
} from "@codexhost/shared-contracts";
import { WebHarnessPreferences } from "../src/harness-preferences.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { MixedDrafts } from "../src/mixed-drafts.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChChannel } from "./support/ch-channel.ts";
import type { Inspection } from "../src/harnesses.ts";

it("shares GUI file preferences across Web clients, restores defaults and isolates Codex homes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-preferences-"));
  const store = new HarnessPreferencesStore(join(root, "gui"));
  const host = new FakeChChannel();
  const native = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === HARNESS_PREFERENCES_GET_METHOD)
      return (await store.get(String(params.scope ?? "external"))) as T;
    if (method === HARNESS_PREFERENCES_PATCH_METHOD)
      return (await store.patch(harnessPreferencePatchSchema.parse(params))) as T;
    return native<T>(method, params);
  };
  const data = new DataDir(join(root, "web"));
  const events = new EventHub(root);
  const frames: unknown[] = [];
  const emit = events.emit.bind(events);
  events.emit = (event, ...args) => {
    frames.push(event);
    emit(event, ...args);
  };
  await store.subscribe((revision) => {
    for (const listener of host.listeners)
      listener({
        type: "preferences-changed",
        cursor: { epoch: host.epoch, sequence: ++host.sequence },
        revision,
      });
  });
  const a = new WebHarnessPreferences(host, data, events, join(root, "home-a"));
  const b = new WebHarnessPreferences(host, data, events, join(root, "home-b"));
  const workspaces = new Workspaces(data, root, true);
  const sessions = new ChSessions(host, workspaces, events, undefined, undefined, undefined, a);
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  sessions.registerCommands(rpc);
  a.register(rpc);
  await a.initialize({ provider: "fake", model: "legacy" });
  assert.equal((await a.get()).values.newThread?.lastHarness, "fake");
  assert.equal((await a.configuration("fake"))?.model?.id, "legacy");
  t.after(async () => {
    await sessions.close();
    await a.close();
    await b.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method: string, args: Record<string, unknown>) => {
    const result = await rpc.dispatch(method, { args });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  await store.patch(
    harnessPreferencePatchSchema.parse({
      operations: [
        { kind: "idleRelease", value: { enabled: true, timeoutMinutes: 25 } },
        { kind: "favorite", harnessId: "fake", modelId: "native", enabled: true },
        {
          kind: "newThread",
          lastHarness: "fake",
          harnessId: "fake",
          configuration: { model: { id: "native" }, permissionModeId: "auto" },
        },
      ],
    }),
  );
  assert.equal(frames.includes("codexhost/preferences-changed"), true);
  assert.deepEqual((await b.get()).values.favorites.fake, ["native"]);
  await call("codexhost/preferences/migrate", {
    favorites: [{ provider: "fake", modelIds: ["stale"] }],
  });
  assert.deepEqual((await a.get()).values.favorites.fake, ["native"]);
  await call("codexhost/preferences/patch", {
    operation: { kind: "idleRelease", value: { enabled: false, timeoutMinutes: 25 } },
  });
  assert.equal((await store.get()).values.idleRelease?.enabled, false);
  await a.remember("codex", { model: { id: "code-a" } });
  assert.equal((await a.configuration("codex"))?.model?.id, "code-a");
  assert.equal(await b.configuration("codex"), undefined);
  assert.equal((await store.get()).values.newThread?.byHarness.codex, undefined);
  await a.remember("fake", { model: { id: "native" }, permissionModeId: "auto" });
  await a.initialize({ provider: "fake", model: "obsolete" });
  assert.equal((await a.configuration("fake"))?.model?.id, "native");
  await call("session/create", { sessionId: "first", cwd: root });
  const projection = (await call("session/projections", { sessionId: "first" })) as {
    values: Record<string, unknown>;
  };
  assert.deepEqual(projection.values.permissions, { currentValue: "auto" });
  await call("commands/execute", { agentId: "first", line: "/permission ask" });
  await call("session/create", { sessionId: "second", cwd: root });
  const next = (await call("session/projections", { sessionId: "second" })) as {
    values: Record<string, unknown>;
  };
  assert.deepEqual(next.values.permissions, { currentValue: "ask" });
  const inspection = await sessions.catalog.inspect("fake");
  const drafts = new MixedDrafts(
    {
      models: () => sessions.catalog.models(),
      inspect: async () => inspection as Inspection,
      name: async () => "Fake",
      preferences: a,
    },
    workspaces,
    events,
    () => ({}),
  );
  t.after(() => drafts.close());
  await drafts.create({ sessionId: "mixed", cwd: root });
  assert.equal(drafts.entries.get("mixed")?.permissionModeId, "ask");
  assert.equal(existsSync(join(data.root, "harness-preferences-v1.json")), false);
  assert.equal(
    host.requests.some((request) => ["thread/start", "turn/start"].includes(request.method)),
    false,
  );
  frames.length = 0;
  host.connection(false);
  host.connection(true);
  assert.equal(frames.includes("codexhost/preferences-changed"), true);
});

it("retains normal catalogs when an older Host lacks preference methods", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-old-preferences-"));
  const prefs = new WebHarnessPreferences(
    new FakeChChannel(),
    new DataDir(root),
    new EventHub(root),
  );
  try {
    const result = await prefs.decorate({
      default: { provider: "fake", model: "native" },
      groups: [],
    });
    assert.equal(result.preferencesAvailable, false);
    assert.equal(result.default.model, "native");
  } finally {
    await prefs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
