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
interface Result {
  ok: true;
  value: Value;
}
interface Catalog {
  load(): Promise<Value>;
  refresh(): void;
  resetGeneration(): void;
  dispose(): void;
  store: { getSnapshot(): { value: Value | null; status: string } };
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
  let active = 0,
    peak = 0;
  const catalog = new Constructor({
    remote: {
      session: {
        modelCatalog: () => {
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
  return { catalog, reads, peak: () => peak };
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
  assert.throws(() => parameter.codec.create().parse({}), /sessionId/);
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
