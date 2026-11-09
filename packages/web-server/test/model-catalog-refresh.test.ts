/** Exercises the browser catalog owner without importing its workspace source as a Node dependency. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";

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
const Constructor = (module.exports as { ModelCatalogDirectory: new (ctx: unknown) => Catalog })
  .ModelCatalogDirectory;
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
