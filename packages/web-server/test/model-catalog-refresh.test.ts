/** Exercises the browser catalog owner without importing its workspace source as a Node dependency. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Load the pinned JavaScript wire snapshot without importing the unported upstream type graph.
const { TYPERT_REMOTE } = (await import(
  new URL(
    "../../../apps/web-ui/packages/api/session-controller/generated/remote.js",
    import.meta.url,
  ).href
)) as {
  TYPERT_REMOTE: {
    descriptors: Array<{
      id: string;
      parameters: Array<{
        name: string;
        wire: string;
        acceptsUndefined?: boolean;
        codec: { mode: string; create(): { parse(value: unknown): unknown } };
      }>;
    }>;
  };
};

interface Value {
  harnessOrder: string[];
}
type Result = { ok: true; value: Value } | { ok: false; error: { code: string; message: string } };
interface Catalog {
  load(): Promise<Value>;
  refresh(): void;
  refreshModels(harnessId?: string): Promise<Value>;
  resetGeneration(): void;
  dispose(): void;
  store: { getSnapshot(): { value: Value | null; status: string; error: string | null } };
}
const output = await build({
  entryPoints: [
    resolve(
      import.meta.dirname,
      "../../../apps/web-ui/packages/client/ui-model-selection/src/client/catalog.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const module = { exports: {} };
runInNewContext(output.outputFiles[0]?.text ?? "", {
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  Error,
  console,
  process: { env: { NODE_ENV: "test" } },
  queueMicrotask,
  setTimeout,
  clearTimeout,
});
const Constructor = (
  module.exports as {
    ModelCatalogDirectory: new (ctx: unknown, sessionId?: string) => Catalog;
  }
).ModelCatalogDirectory;
const response = (order: string[]): Result =>
  ({
    ok: true,
    value: { default: { provider: "pi", model: "m" }, groups: [], harnessOrder: order },
  }) as unknown as Result;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const reads: Array<ReturnType<typeof Promise.withResolvers<Result>>> = [];
  const requests: unknown[] = [];
  let active = 0,
    peak = 0;
  const catalog = new Constructor({
    remote: {
      session: {
        modelCatalog: (request: unknown) => {
          requests.push(request);
          const reply = Promise.withResolvers<Result>();
          reads.push(reply);
          active++;
          peak = Math.max(peak, active);
          return reply.promise.finally(() => {
            active--;
          });
        },
      },
    },
  });
  return { catalog, reads, requests, peak: () => peak };
}

it("coalesces a notification burst during initial read and only publishes the latest sorting", async () => {
  const f = fixture();
  const loading = f.catalog.load();
  for (let i = 0; i < 20; i++) f.catalog.refresh();
  assert.equal(f.reads.length, 1);
  f.reads[0]?.resolve(response(["pi", "grok"]));
  await flush();
  assert.equal(f.reads.length, 2);
  assert.equal(f.catalog.store.getSnapshot().value, null);
  f.reads[1]?.resolve(response(["grok", "pi"]));
  await loading;
  assert.deepEqual(f.catalog.store.getSnapshot().value?.harnessOrder, ["grok", "pi"]);
  assert.equal(f.peak(), 1);
  f.catalog.dispose();
});

it("queues a targeted user refresh and reads notifications without refreshing other Harnesses", async () => {
  const f = fixture();
  const initial = f.catalog.load();
  const refreshing = f.catalog.refreshModels("pi");
  assert.deepEqual(f.requests, [undefined]);
  f.reads[0]?.resolve(response(["old"]));
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    null,
    { refresh: true, harnessId: "pi" },
  ]);
  f.catalog.refresh();
  f.reads[1]?.resolve(response(["pi", "grok"]));
  await flush();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2], undefined);
  f.reads[2]?.resolve(response(["new"]));
  await initial;
  await refreshing;
  assert.deepEqual(f.catalog.store.getSnapshot().value?.harnessOrder, ["new"]);
  assert.equal(f.peak(), 1);
  f.catalog.dispose();
});

it("preserves different queued refresh targets and falls back to all only without a target", async () => {
  const f = fixture();
  const pi = f.catalog.refreshModels("pi");
  const claude = f.catalog.refreshModels("claude-code");
  const grok = f.catalog.refreshModels("grok");
  for (const index of [0, 1, 2]) {
    assert.equal(f.reads.length, index + 1);
    f.reads[index]?.resolve(response(["pi", "claude-code", "grok"]));
    await flush();
  }
  await Promise.all([pi, claude, grok]);
  const all = f.catalog.refreshModels();
  f.reads[3]?.resolve(response(["pi", "claude-code", "grok"]));
  await all;
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    { refresh: true, harnessId: "pi" },
    { refresh: true, harnessId: "claude-code" },
    { refresh: true, harnessId: "grok" },
    { refresh: true },
  ]);
  assert.equal(f.peak(), 1);
  f.catalog.dispose();
});

it("keeps a targeted transport failure visible after a successful notification read", async () => {
  const f = fixture();
  const refresh = f.catalog.refreshModels("pi");
  const rejected = assert.rejects(refresh, /Pi refresh failed/);
  f.catalog.refresh();
  f.reads[0]?.reject(new Error("Pi refresh failed"));
  await flush();
  assert.equal(f.requests[1], undefined);
  f.reads[1]?.resolve(response(["new"]));
  await rejected;
  const state = f.catalog.store.getSnapshot();
  assert.deepEqual(state.value?.harnessOrder, ["new"]);
  assert.equal(state.status, "error");
  assert.equal(state.error, "Pi refresh failed");
  f.catalog.dispose();
});

it("keeps a targeted RPC failure visible after another Harness refresh succeeds", async () => {
  const f = fixture();
  const pi = f.catalog.refreshModels("pi");
  const rejected = assert.rejects(pi, /unavailable: Pi refresh failed/);
  const claude = f.catalog.refreshModels("claude-code");
  assert.equal(pi, claude);
  f.reads[0]?.resolve({ ok: false, error: { code: "unavailable", message: "Pi refresh failed" } });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1])), {
    refresh: true,
    harnessId: "claude-code",
  });
  f.reads[1]?.resolve(response(["claude-code"]));
  await rejected;
  const state = f.catalog.store.getSnapshot();
  assert.deepEqual(state.value?.harnessOrder, ["claude-code"]);
  assert.equal(state.status, "error");
  assert.equal(state.error, "unavailable: Pi refresh failed");
  f.catalog.dispose();
});

it("a transport failure with a pending notification still reconciles the latest catalog", async () => {
  const f = fixture();
  const loading = f.catalog.load();
  f.catalog.refresh();
  f.reads[0]?.reject(new Error("Read failed"));
  await flush();
  assert.equal(f.reads.length, 2);
  f.reads[1]?.resolve(response(["grok", "pi"]));
  await loading;
  assert.deepEqual(f.catalog.store.getSnapshot().value?.harnessOrder, ["grok", "pi"]);
  f.catalog.dispose();
});

it("rejects late generation results and performs no reads after disposal", async () => {
  const f = fixture();
  const old = f.catalog.load();
  f.catalog.resetGeneration();
  const fresh = f.catalog.load();
  f.reads[1]?.resolve(response(["grok", "pi"]));
  await fresh;
  f.reads[0]?.resolve(response(["pi", "grok"]));
  await old;
  assert.deepEqual(f.catalog.store.getSnapshot().value?.harnessOrder, ["grok", "pi"]);
  f.catalog.refresh();
  const late = f.catalog.load();
  f.catalog.dispose();
  f.catalog.refresh();
  f.catalog.resetGeneration();
  f.reads[2]?.resolve(response(["claude-code"]));
  await late;
  assert.deepEqual(f.catalog.store.getSnapshot().value?.harnessOrder, ["grok", "pi"]);
  assert.equal(f.reads.length, 3);
  await assert.rejects(f.catalog.load(), /disposed/);
});

it("keeps the optional model catalog request in the pinned Remote wire descriptor", () => {
  const descriptor = TYPERT_REMOTE.descriptors.find(
    ({ id }) => id === "@deepseek-ai/dsh-api-session-controller#session/modelCatalog",
  );
  assert.ok(descriptor);
  const parameter = descriptor.parameters[0];
  assert.ok(parameter);
  assert.equal(parameter.name, "request");
  assert.equal(parameter.wire, "request");
  assert.equal(parameter.acceptsUndefined, true);
  assert.equal(parameter.codec.mode, "strict");
  assert.equal(parameter.codec.create().parse(undefined), undefined);
  assert.deepEqual(parameter.codec.create().parse({ sessionId: "web-remote:wire-test" }), {
    sessionId: "web-remote:wire-test",
  });
  assert.deepEqual(parameter.codec.create().parse({ refresh: true }), { refresh: true });
  assert.deepEqual(parameter.codec.create().parse({ refresh: true, harnessId: "pi" }), {
    refresh: true,
    harnessId: "pi",
  });
  assert.throws(() => parameter.codec.create().parse({ refresh: true, harnessId: 1 }));
  assert.throws(() => parameter.codec.create().parse({}));
  assert.throws(() => parameter.codec.create().parse({ refresh: false }));
});

it("keeps the shared local catalog separate from per-remote session catalogs", async () => {
  const remoteA = "web-remote:host-a/thread-a";
  const remoteB = "web-remote:host-b/thread-b";
  const calls: unknown[][] = [];
  const modelCatalog = (...args: unknown[]) => {
    calls.push(args);
    const sessionId = (args[0] as { sessionId?: string } | undefined)?.sessionId;
    const order = sessionId === undefined ? ["local"] : [sessionId];
    return Promise.resolve(response(order));
  };
  const ctx = { remote: { session: { modelCatalog } } };
  const local = new Constructor(ctx);
  const scopedA = new Constructor(ctx, remoteA);
  const scopedB = new Constructor(ctx, remoteB);

  await local.load();
  await local.load();
  await scopedA.load();
  await scopedA.load();
  await scopedB.load();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [null],
    [{ sessionId: remoteA }],
    [{ sessionId: remoteB }],
  ]);
  assert.deepEqual(local.store.getSnapshot().value?.harnessOrder, ["local"]);
  assert.deepEqual(scopedA.store.getSnapshot().value?.harnessOrder, [remoteA]);
  assert.deepEqual(scopedB.store.getSnapshot().value?.harnessOrder, [remoteB]);

  scopedA.resetGeneration();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [null],
    [{ sessionId: remoteA }],
    [{ sessionId: remoteB }],
    [{ sessionId: remoteA }],
  ]);
  assert.deepEqual(scopedA.store.getSnapshot().value?.harnessOrder, [remoteA]);

  local.dispose();
  scopedA.dispose();
  scopedB.dispose();
});
