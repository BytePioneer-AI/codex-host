import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";

import { HarnessRegistry } from "../src/harnesses.ts";

async function root(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "web-harness-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function plugin(
  root: string,
  id: string,
  options: { directoryName?: string; returnedId?: string; entry?: string; usage?: boolean } = {},
): Promise<string> {
  const directory = path.join(root, options.directoryName ?? id);
  await mkdir(directory);
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      adapterApiVersion: 1,
      entry: options.entry ?? "plugin.mjs",
      ...(options.usage ? { kind: "usage" } : {}),
    }),
  );
  await writeFile(
    path.join(directory, "plugin.mjs"),
    `import { appendFileSync } from "node:fs";
     const mark = (stage) => appendFileSync(new URL("lifecycle", import.meta.url), stage + "\\n");
     mark("import");
     export function createHarnessAdapter(context) {
       mark("factory");
       return {
         harnessId: ${JSON.stringify(options.returnedId ?? id)},
         inspect: async () => ({ status: "ready", catalog: {
           models: [{ ref: { id: "fake-model" }, label: "Fake model" }],
           defaultModel: { id: "fake-model" }, thinkingOptions: []
         }, capabilities: {
           configuration: { selectModel: true, selectThinkingOption: false, selectPermissionMode: false },
           history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false }
         } }),
         open: async () => { throw new Error("no native execution in this test"); },
         close: async () => mark("close")
       };
     }`,
  );
  return directory;
}

for (const configuration of ["default", "enabled", "external"] as const) {
  it(`keeps Codex imports out of the ${configuration} external registry`, async (t) => {
    const directory = await root(t);
    const codex = await plugin(directory, "codex");
    const external = await plugin(directory, "fake-agent");
    const usage = await plugin(directory, "codex-usage", { usage: true });
    const registry = new HarnessRegistry(
      [directory],
      configuration === "default" ? undefined : new Set(["codex", "fake-agent", "codex-usage"]),
      configuration === "external" ? { scope: "external" } : {},
    );
    t.after(() => registry.close());
    assert.deepEqual(registry.ids(), ["fake-agent"]);
    assert.equal(registry.manifest("codex"), undefined);
    await assert.rejects(registry.adapter("codex"), /Unknown Harness codex/u);
    const catalog = await registry.modelCatalog();
    assert.deepEqual(
      catalog.groups.map(({ id }) => id),
      ["fake-agent"],
    );
    assert.equal(existsSync(path.join(codex, "lifecycle")), false);
    assert.equal(existsSync(path.join(usage, "lifecycle")), false);
    assert.equal(await readFile(path.join(external, "lifecycle"), "utf8"), "import\nfactory\n");
  });
}

it("requires explicit Codex enablement in the Web scope", async (t) => {
  const directory = await root(t);
  const codex = await plugin(directory, "codex");
  await plugin(directory, "fake-agent");
  for (const enabled of [undefined, new Set<string>(), new Set(["fake-agent"])]) {
    const registry = new HarnessRegistry([directory], enabled, { scope: "web-codex" });
    assert.deepEqual(registry.ids(), []);
    assert.deepEqual((await registry.modelCatalog()).groups, []);
    await registry.close();
  }
  assert.equal(existsSync(path.join(codex, "lifecycle")), false);
});

it("imports and constructs only the explicitly enabled Codex adapter in Web scope", async (t) => {
  const directory = await root(t);
  const codex = await plugin(directory, "codex");
  const external = await plugin(directory, "fake-agent");
  const registry = new HarnessRegistry([directory], new Set(["codex", "fake-agent"]), {
    scope: "web-codex",
  });
  assert.deepEqual(registry.ids(), ["codex"]);
  const [first, second] = await Promise.all([registry.adapter("codex"), registry.adapter("codex")]);
  assert.equal(first, second);
  assert.equal((await registry.modelCatalog()).default.provider, "codex");
  assert.equal(await readFile(path.join(codex, "lifecycle"), "utf8"), "import\nfactory\n");
  assert.equal(existsSync(path.join(external, "lifecycle")), false);
  await registry.close();
  assert.equal(await readFile(path.join(codex, "lifecycle"), "utf8"), "import\nfactory\nclose\n");
});

it("rejects an adapter that claims another identity and closes the rejected instance", async (t) => {
  const directory = await root(t);
  const codex = await plugin(directory, "codex", { returnedId: "fake-agent" });
  const registry = new HarnessRegistry([directory], new Set(["codex"]), { scope: "web-codex" });
  await assert.rejects(registry.adapter("codex"), /Invalid Harness plugin: codex/u);
  assert.equal(await readFile(path.join(codex, "lifecycle"), "utf8"), "import\nfactory\nclose\n");
  await registry.close();
});

it("rejects duplicate enabled identities before either module is imported", async (t) => {
  const firstRoot = await root(t);
  const secondRoot = await root(t);
  const first = await plugin(firstRoot, "codex");
  const second = await plugin(secondRoot, "codex");
  assert.throws(
    () => new HarnessRegistry([firstRoot, secondRoot], new Set(["codex"]), { scope: "web-codex" }),
    /Duplicate Harness plugin: codex/u,
  );
  assert.equal(existsSync(path.join(first, "lifecycle")), false);
  assert.equal(existsSync(path.join(second, "lifecycle")), false);
});

it("rejects a parent-relative entry before import", async (t) => {
  const directory = await root(t);
  const codex = await plugin(directory, "codex", { entry: "../escape.mjs" });
  assert.throws(() => new HarnessRegistry([directory], new Set(["codex"]), { scope: "web-codex" }));
  assert.equal(existsSync(path.join(codex, "lifecycle")), false);
});

it("rejects an entry symlink escaping its plugin directory before import", async (t) => {
  const directory = await root(t);
  const outside = await root(t);
  const codex = await plugin(directory, "codex", { entry: "escape.mjs" });
  await writeFile(
    path.join(outside, "plugin.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(new URL("executed", import.meta.url), "yes");`,
  );
  try {
    await symlink(path.join(outside, "plugin.mjs"), path.join(codex, "escape.mjs"));
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      t.skip("File symlinks are unavailable without Developer Mode on this Windows host");
      return;
    }
    throw error;
  }
  const registry = new HarnessRegistry([directory], new Set(["codex"]), { scope: "web-codex" });
  await assert.rejects(registry.adapter("codex"), /inside its root/iu);
  assert.equal(existsSync(path.join(outside, "executed")), false);
  assert.equal(existsSync(path.join(codex, "lifecycle")), false);
  await registry.close();
});
