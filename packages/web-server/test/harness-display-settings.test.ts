import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { harnessDisplaySetSchema, type HarnessDisplaySettings } from "@codexhost/shared-contracts";
import { WebHarnessDisplaySettings } from "../src/harness-display-settings.ts";
import { EventHub, RpcRegistry } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

const prefix = "codexhost/harness/display-settings/";
const initial = [
  { agent: "pi", section: "main" as const },
  { agent: "grok", section: "auto" as const },
];
const next = [...initial].reverse();
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup(t: TestContext, eventsEnabled = true) {
  const root = mkdtempSync(join(tmpdir(), "web-display-events-"));
  const file = join(root, "harness-display-settings-v1.json");
  writeFileSync(file, JSON.stringify(initial));
  const host = new FakeChChannel();
  const requests: string[] = [];
  let value: HarnessDisplaySettings = { entries: initial };
  let failWrites = false;
  const changed = () => {
    for (const listener of host.listeners)
      listener({
        type: "display-settings-changed",
        cursor: { epoch: host.epoch, sequence: ++host.sequence },
      });
  };
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    requests.push(method);
    if (method === prefix + "capabilities") return { events: eventsEnabled } as T;
    if (method === prefix + "get") return structuredClone(value) as T;
    if (method === prefix + "set") {
      if (failWrites) throw new Error("Save failed");
      value = { entries: harnessDisplaySetSchema.parse(params).entries };
      writeFileSync(file, JSON.stringify(value.entries));
      if (eventsEnabled) changed();
      return structuredClone(value) as T;
    }
    throw new Error("Unexpected method " + method);
  };
  const frames: string[] = [];
  const events = new EventHub(root);
  events.emit = (event) => {
    frames.push(event);
  };
  const service = new WebHarnessDisplaySettings(host, root, events);
  const rpc = new RpcRegistry();
  service.register(rpc);
  t.after(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (method: string, args = {}) =>
    rpc.dispatch("codexhost/display-settings/" + method, { args });
  return {
    root,
    file,
    host,
    requests,
    frames,
    service,
    call,
    changed,
    fail: () => {
      failWrites = true;
    },
    set: (entries: typeof initial) => {
      value = { entries };
    },
  };
}

it("forwards confirmed Host changes without polling or executing a Harness and preserves failed writes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = setup(t);
  assert.deepEqual(await f.call("capabilities"), { ok: true, value: { events: true } });
  const before = f.requests.length;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.requests.length, before);
  f.frames.length = 0;
  assert.deepEqual(await f.call("set", { request: { entries: next } }), {
    ok: true,
    value: { entries: next },
  });
  assert.deepEqual(f.frames, ["codexhost/display-settings-changed"]);
  assert.deepEqual(await f.service.entries(), next);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), next);
  f.fail();
  f.frames.length = 0;
  assert.equal((await f.call("set", { request: { entries: initial } })).ok, false);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(await f.service.entries(), next);
  assert.equal(
    f.requests.every((method) => method.startsWith(prefix)),
    true,
  );
  f.service.close();
  f.changed();
  assert.deepEqual(f.frames, []);
  assert.equal(f.host.listeners.size, 0);
});

it("only explicitly legacy capabilities poll, deduplicate unchanged order and stop on close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = setup(t, false);
  assert.deepEqual(await f.call("capabilities"), { ok: true, value: { events: false } });
  await flush();
  f.frames.length = 0;
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(f.frames, []);
  f.set(next);
  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(f.frames, ["codexhost/display-settings-changed"]);
  f.service.close();
  const before = f.requests.length;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(f.requests.length, before);
});

it("rejects old-generation reads, writes and capability results after reconnect", async (t) => {
  const f = setup(t);
  await f.call("capabilities");
  const original = f.host.request.bind(f.host);
  const read = Promise.withResolvers<HarnessDisplaySettings>();
  const write = Promise.withResolvers<HarnessDisplaySettings>();
  f.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === prefix + "get"
      ? (read.promise as Promise<T>)
      : method === prefix + "set"
        ? (write.promise as Promise<T>)
        : original<T>(method, params);
  const reading = f.service.get();
  const writing = f.call("set", { request: { entries: next } });
  f.host.connection(false);
  f.host.connection(true);
  await f.call("capabilities");
  f.frames.length = 0;
  read.resolve({ entries: initial });
  write.resolve({ entries: initial });
  await assert.rejects(reading, /connection changed/);
  assert.equal((await writing).ok, false);
  assert.deepEqual(f.frames, []);
  const capability = Promise.withResolvers<{ events: boolean }>();
  f.host.request = async <T>(): Promise<T> => capability.promise as Promise<T>;
  f.host.connection(false);
  f.host.connection(true);
  const oldCapability = f.call("capabilities");
  f.host.connection(false);
  f.host.request = original;
  f.host.connection(true);
  capability.resolve({ events: true });
  assert.equal((await oldCapability).ok, false);
  assert.deepEqual(await f.call("capabilities"), { ok: true, value: { events: true } });
});

it("an unsupported old Host reads the existing file while a transport failure does not enable polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = setup(t);
  await f.call("capabilities");
  let calls = 0;
  f.host.request = async () => {
    calls++;
    throw Object.assign(new Error("Unsupported"), { code: -32601 });
  };
  f.host.connection(false);
  f.host.connection(true);
  assert.deepEqual(await f.call("capabilities"), { ok: true, value: { events: false } });
  assert.deepEqual(await f.service.entries(), initial);
  await flush();
  const before = calls;
  t.mock.timers.tick(3000);
  await flush();
  assert.ok(calls > before);
  f.host.connection(false);
  f.host.request = async () => {
    calls++;
    throw new Error("Transport failed");
  };
  f.host.connection(true);
  assert.equal((await f.call("capabilities")).ok, false);
  const offlineCalls = calls;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, offlineCalls);
});

it("keeps a successfully saved snapshot when the next read fails and rejects retirement during fallback", async (t) => {
  const f = setup(t);
  await f.call("capabilities");
  await f.service.get();
  assert.equal((await f.call("set", { request: { entries: next } })).ok, true);
  const original = f.host.request.bind(f.host);
  f.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === prefix + "get") throw new Error("Read failed");
    return original<T>(method, params);
  };
  assert.deepEqual(await f.service.entries(), next);
  const pending = Promise.withResolvers<HarnessDisplaySettings>();
  f.host.request = async <T>(): Promise<T> => pending.promise as Promise<T>;
  const entries = f.service.entries();
  f.service.close();
  pending.reject(new Error("Read failed after close"));
  await assert.rejects(entries, /connection changed/);
});

it("does not publish legacy Host reads that finish after disposal", async (t) => {
  const f = setup(t);
  f.host.request = async () => {
    throw Object.assign(new Error("Unsupported"), { code: -32601 });
  };
  const reading = f.service.get();
  f.service.close();
  await assert.rejects(reading, /connection changed/);
});
