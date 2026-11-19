import assert from "node:assert/strict";
import { it } from "node:test";
import { harnessInspectionSchema, type HarnessInspection } from "@codexhost/shared-contracts";
import { ChHarnessCatalog } from "../src/ch-harness-catalog.ts";
import { EventHub } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

const failed: HarnessInspection = {
  status: "unavailable",
  error: { code: "authenticationRequired", message: "Please log in", retryable: true },
};
function fixture() {
  const host = new FakeChChannel();
  const events = new EventHub("/unused");
  const emitted: string[] = [];
  events.emit = (event) => {
    emitted.push(event);
  };
  const catalog = new ChHarnessCatalog(host, events);
  emitted.length = 0; // Initial hello.
  const invalidate = (harnessId = "fake") => {
    for (const listener of host.listeners)
      listener({
        type: "harness-inspection-changed",
        harnessId,
        cursor: { epoch: host.epoch, sequence: ++host.sequence },
      });
  };
  const requests = () => host.requests.filter((r) => r.method === "codexhost/harness/inspect");
  return { host, catalog, emitted, invalidate, requests };
}

it("caches failures until Host invalidation, then rereads all cwd entries only for that Harness", async (t) => {
  const { host, catalog, emitted, invalidate, requests } = fixture();
  t.after(() => catalog.close());
  const request = host.request.bind(host);
  let result: HarnessInspection = failed;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const value = await request<T>(method, params);
    return method === "codexhost/harness/inspect" ? (result as T) : value;
  };
  for (const cwd of [undefined, "/a", "/b"]) {
    assert.equal((await catalog.inspect("fake", cwd)).status, "unavailable");
    await catalog.inspect("fake", cwd);
  }
  await catalog.inspect("other");
  assert.equal(requests().length, 4);
  result = harnessInspectionSchema.parse(host.inspection);
  invalidate();
  assert.deepEqual(emitted, ["codexhost/harness-inspection-changed"]);
  for (const cwd of [undefined, "/a", "/b"])
    assert.equal((await catalog.inspect("fake", cwd)).status, "ready");
  assert.equal((await catalog.inspect("other")).status, "unavailable");
  assert.equal(requests().length, 7);
});

it("shares in-flight inspections and retains ready results until invalidated", async (t) => {
  const { host, catalog, invalidate, requests } = fixture();
  t.after(() => catalog.close());
  const pending = catalog.inspect("fake");
  const concurrent = catalog.inspect("fake");
  const first = await pending;
  assert.deepEqual(await concurrent, first);
  assert.equal(requests().length, 1);
  host.inspection.catalog.models.push({ ref: { id: "new" }, label: "New model" });
  assert.deepEqual(await catalog.inspect("fake"), first);
  invalidate();
  const next = await catalog.inspect("fake");
  assert.equal(next.status === "ready" && next.catalog.models.length, 2);
  assert.equal(requests().length, 2);
});

for (const completion of ["ready", "codex-failure", "throw"] as const)
  it(`does not let a late ${completion} request overwrite or delete a newer request`, async (t) => {
    const { host, catalog, invalidate } = fixture();
    t.after(() => catalog.close());
    const id = completion === "codex-failure" ? "codex" : "fake";
    const old = Promise.withResolvers<HarnessInspection>();
    const request = host.request.bind(host);
    let calls = 0;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/harness/inspect") {
        if (++calls === 1) return old.promise as Promise<T>;
        return host.inspection as T;
      }
      return request<T>(method, params);
    };
    const first = catalog.inspect(id);
    const caught = first.catch(() => undefined);
    invalidate(id);
    const next = await catalog.inspect(id);
    if (completion === "throw") old.reject(new Error("old request failed"));
    else
      old.resolve(
        completion === "codex-failure"
          ? failed
          : harnessInspectionSchema.parse({
              ...host.inspection,
              catalog: { models: [], thinkingOptions: [] },
            }),
      );
    await caught;
    assert.deepEqual(await catalog.inspect(id), next);
    assert.equal(calls, 2);
  });

it("clears inspections and plugin discovery on hello and unsubscribes on close", async () => {
  const { host, catalog, emitted, requests } = fixture();
  await catalog.list();
  await catalog.inspect("fake");
  host.connection(true);
  await catalog.list();
  await catalog.inspect("fake");
  assert.equal(requests().length, 2);
  assert.equal(
    host.requests.filter((r) => r.method === "codexhost/harness/plugins/list").length,
    2,
  );
  assert.deepEqual(emitted, ["codexhost/harness-inspection-changed"]);
  assert.equal(host.listeners.size, 1);
  catalog.close();
  assert.equal(host.listeners.size, 0);
});

it("does not let a pre-hello plugin-list failure delete the new plugin-list cache", async (t) => {
  const { host, catalog } = fixture();
  t.after(() => catalog.close());
  const old = Promise.withResolvers<unknown>();
  const request = host.request.bind(host);
  let calls = 0;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/harness/plugins/list" && ++calls === 1)
      return old.promise as Promise<T>;
    return request<T>(method, params);
  };
  const first = catalog.list().catch(() => undefined);
  host.connection(true);
  const next = await catalog.list();
  old.reject(new Error("old Host disconnected"));
  await first;
  assert.deepEqual(await catalog.list(), next);
  assert.equal(calls, 2);
});

it("keeps Codex non-ready results uncached", async (t) => {
  const { host, catalog } = fixture();
  t.after(() => catalog.close());
  let calls = 0;
  host.request = async <T>(): Promise<T> => {
    calls++;
    return failed as T;
  };
  await catalog.inspect("codex");
  await catalog.inspect("codex");
  assert.equal(calls, 2);
});
