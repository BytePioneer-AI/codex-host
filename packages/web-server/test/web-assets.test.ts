/** Installed browser artifacts compose with both source and packed Web distributions. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";

import { WebAssets, type WebAssetOptions } from "../src/web-assets.ts";
import { CLIENT_RUNTIME_VERSIONS_FILE } from "../src/client-runtime-versions.ts";

const BUILTIN = "@fixture/builtin";
const ADDON = "@fixture/addon";
const SHELL = "<html><head><title>T</title></head><body></body></html>";
const BUNDLE = `window.__ModuleLoader__.load({id: "${ADDON}", factory: require => ({apply() { return require("react"); }})});\n`;

/** Compare fixture code independently of the native combo separators and source-map trailer. */
function script(assets: WebAssets, path: string): string | undefined {
  return assets
    .plugin(path)
    ?.body.toString()
    .replace(/\n;\n/g, "\n")
    .replace(/\/\/# sourceMappingURL=[^\n]*\n?/g, "");
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(t: TestContext): { root: string; directory: string; options: WebAssetOptions } {
  const root = mkdtempSync(join(tmpdir(), "codexhost-web-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const builtin = join(root, "packages/client/builtin");
  write(
    join(builtin, "package.json"),
    JSON.stringify({
      name: BUILTIN,
      exports: { "./client": "./lib/client.js" },
      dsh: { client: { platform: "web" } },
    }),
  );
  write(join(builtin, "lib/client.js"), "builtin();\n");
  write(join(root, "apps/web/dist/index.html"), SHELL);
  mkdirSync(join(root, "vendor"));
  const directory = join(root, "installed/addon");
  write(
    join(directory, "package.json"),
    JSON.stringify({
      name: ADDON,
      version: "1.2.3",
      exports: { ".": "./host.js", "./client": { default: "./lib/client.js" } },
      dsh: {
        client: { platform: "web", inject: [BUILTIN], external: ["react", `${BUILTIN}/client`] },
      },
    }),
  );
  write(join(directory, "host.js"), 'throw new Error("Host entry must never execute");\n');
  write(join(directory, "lib/client.js"), BUNDLE);
  write(join(directory, "lib/client.details.js"), "chunk(1);\n");
  return {
    root,
    directory,
    options: { repoRoot: root, plugins: [BUILTIN], globals: {}, title: "T" },
  };
}

function editManifest(directory: string, edit: (manifest: Record<string, unknown>) => void): void {
  const path = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(manifest);
  write(path, JSON.stringify(manifest));
}

it("exports temporary browser builds without replacing development bundles", (t) => {
  const { root, options } = fixture(t);
  const buildRoot = join(root, "temporary-build");
  write(join(buildRoot, "apps/web/dist/index.html"), SHELL);
  write(join(buildRoot, "packages/client/builtin/lib/client.js"), "release();\n");
  const assets = new WebAssets({ ...options, buildRoot });
  const output = join(root, "release-web");
  const [plugin] = assets.exportPlugins(output);
  assert.ok(plugin);
  assert.equal(
    readFileSync(join(output, "plugins", plugin.dir, "client.js"), "utf8"),
    "release();\n",
  );
  assert.equal(
    readFileSync(join(root, "packages/client/builtin/lib/client.js"), "utf8"),
    "builtin();\n",
  );
});

for (const mode of ["source", "packed"] as const) {
  it(`composes original browser packages with ${mode} assets and leaves recovery built-in only`, (t) => {
    const { root, directory, options } = fixture(t);
    let base = options;
    if (mode === "packed") {
      const packedRoot = join(root, "distribution/web");
      new WebAssets(options).exportPlugins(packedRoot);
      write(join(packedRoot, "index.html"), SHELL);
      base = { packedRoot, plugins: [BUILTIN], globals: {}, title: "T" };
    }
    const assets = new WebAssets({ ...base, externalPlugins: [{ id: ADDON, directory }] });
    assert.deepEqual(
      assets.graph.entries.map(({ id }) => id),
      [BUILTIN, ADDON],
    );
    const entry = assets.graph.entries.find(({ id }) => id === ADDON);
    assert.ok(entry);
    assert.equal(script(assets, `/${entry.url}`), BUNDLE);
    assert.equal(
      script(assets, `/plugins/${ADDON}/client.details.js?rev=${entry.rev}`),
      "chunk(1);\n",
    );
    assert.equal(assets.plugin(`/plugins/${ADDON}/host.js`), undefined);
    assert.deepEqual(
      assets.bundles().map(({ id }) => id),
      [BUILTIN],
    );

    const recovery = new WebAssets(base);
    assert.deepEqual(
      recovery.graph.entries.map(({ id }) => id),
      [BUILTIN],
    );
    assert.equal(recovery.plugin(`/${entry.url}`), undefined);
    const exported = assets.exportPlugins(join(root, "repacked"));
    assert.deepEqual(
      exported.map(({ id }) => id),
      [BUILTIN],
    );
  });
}

it("keeps installed artifacts immutable until restart and revisions include package chunks", (t) => {
  const { directory, options } = fixture(t);
  const selected = { ...options, externalPlugins: [{ id: ADDON, directory }] };
  const assets = new WebAssets(selected);
  const before = assets.graph.entries.find(({ id }) => id === ADDON);
  assert.ok(before);
  assert.equal(script(assets, `/${before.url}`), BUNDLE);
  write(join(directory, "lib/client.details.js"), "chunk(2);\n");
  assert.equal(script(assets, `/plugins/${ADDON}/client.details.js`), "chunk(1);\n");
  assert.equal(assets.rebuilt(ADDON), undefined);
  const restarted = new WebAssets(selected);
  const after = restarted.graph.entries.find(({ id }) => id === ADDON);
  assert.ok(after);
  assert.notEqual(after.rev, before.rev);
  assert.equal(restarted.plugin(`/${before.url}`), undefined);
  assert.equal(
    restarted.plugin(`/plugins/${ADDON}/client.details.js?rev=${before.rev}`),
    undefined,
  );
  assert.equal(script(restarted, `/${after.url}`), BUNDLE);
  assert.equal(
    script(restarted, `/plugins/${ADDON}/client.details.js?rev=${after.rev}`),
    "chunk(2);\n",
  );
  assert.equal(script(restarted, `/plugins/${ADDON}/client.details.js`), "chunk(2);\n");
});

it("checks revisions before returning cached external single and mixed batch responses", (t) => {
  const { directory, options } = fixture(t);
  const selected = { ...options, externalPlugins: [{ id: ADDON, directory }] };
  const assets = new WebAssets(selected);
  const entry = assets.graph.entries.find(({ id }) => id === ADDON);
  const batch = assets.graph.batches.find(({ phase }) => phase === "application");
  assert.ok(entry && batch);
  assert.equal(script(assets, `/${entry.url}`), BUNDLE);
  assert.equal(script(assets, `/${batch.url}`), `builtin();\n${BUNDLE}`);
  assert.equal(assets.plugin(`/${entry.url.replace(entry.rev, "notcurrent")}`), undefined);
  assert.equal(assets.plugin(`/${batch.url.replace(batch.rev, "notcurrent")}`), undefined);
  assert.equal(assets.plugin(`/plugins/${ADDON}/client.details.js?rev=notcurrent`), undefined);
  assert.equal(assets.plugin(`/${entry.url}&rev=${entry.rev}`), undefined);
  assert.equal(script(assets, `/plugins/??${ADDON}/client.js`), BUNDLE);

  write(join(directory, "lib/client.js"), `${BUNDLE}updated();\n`);
  const restarted = new WebAssets(selected);
  assert.equal(restarted.plugin(`/${entry.url}`), undefined);
  assert.equal(restarted.plugin(`/${batch.url}`), undefined);
  for (const current of [
    restarted.graph.entries.find(({ id }) => id === ADDON),
    restarted.graph.batches.find(({ phase }) => phase === "application"),
  ]) {
    assert.ok(current);
    assert.match(restarted.plugin(`/${current.url}`)?.body.toString() ?? "", /updated\(\)/u);
  }
  assert.equal(script(restarted, `/plugins/??${BUILTIN}/client.js&rev=previous`), "builtin();\n");
});

it("accepts both a package revision and a one-package batch revision", (t) => {
  const { directory, options } = fixture(t);
  editManifest(directory, (manifest) => {
    manifest.dsh = { client: { platform: "web", external: ["react"] } };
  });
  const assets = new WebAssets({
    ...options,
    plugins: [],
    externalPlugins: [{ id: ADDON, directory }],
  });
  const entry = assets.graph.entries[0];
  const batch = assets.graph.batches[0];
  assert.ok(entry && batch);
  assert.notEqual(entry.rev, batch.rev);
  assert.equal(script(assets, `/${entry.url}`), BUNDLE);
  assert.equal(script(assets, `/${batch.url}`), BUNDLE);
});

it("rejects duplicate IDs, shell singleton replacements, and package-name mismatches", (t) => {
  const { directory, options } = fixture(t);
  assert.throws(
    () => new WebAssets({ ...options, externalPlugins: [{ id: BUILTIN, directory }] }),
    /duplicate browser plugin/u,
  );
  assert.throws(
    () =>
      new WebAssets({
        ...options,
        externalPlugins: [
          { id: ADDON, directory },
          { id: ADDON, directory },
        ],
      }),
    /duplicate browser plugin/u,
  );
  assert.throws(
    () => new WebAssets({ ...options, externalPlugins: [{ id: "react", directory }] }),
    /cannot replace platform module/u,
  );
  assert.throws(
    () => new WebAssets({ ...options, externalPlugins: [{ id: "@fixture/other", directory }] }),
    /has package name/u,
  );
});

for (const field of ["inject", "external"] as const) {
  it(`requires every external package ${field} dependency to be composed`, (t) => {
    const { directory, options } = fixture(t);
    editManifest(directory, (manifest) => {
      manifest.dsh = { client: { platform: "web", [field]: ["@fixture/missing/client"] } };
    });
    assert.throws(
      () => new WebAssets({ ...options, externalPlugins: [{ id: ADDON, directory }] }),
      /requires unavailable browser module @fixture\/missing\/client/u,
    );
  });
}

it("orders dependencies between registered external packages and rejects cycles", (t) => {
  const { root, directory, options } = fixture(t);
  const dependent = join(root, "installed/dependent");
  write(
    join(dependent, "package.json"),
    JSON.stringify({
      name: "@fixture/dependent",
      exports: { "./client": "./client.js" },
      dsh: { client: { platform: "web", external: [`${ADDON}/client`] } },
    }),
  );
  write(join(dependent, "client.js"), "dependent();\n");
  const selected = {
    ...options,
    externalPlugins: [
      { id: "@fixture/dependent", directory: dependent },
      { id: ADDON, directory },
    ],
  };
  assert.deepEqual(
    new WebAssets(selected).graph.entries.map(({ id }) => id),
    [BUILTIN, ADDON, "@fixture/dependent"],
  );
  editManifest(directory, (manifest) => {
    manifest.dsh = { client: { platform: "web", external: ["@fixture/dependent/client"] } };
  });
  assert.throws(() => new WebAssets(selected), /module graph cycle/u);
  editManifest(directory, (manifest) => {
    manifest.dsh = { client: { platform: "web", inject: ["@fixture/dependent"] } };
  });
  editManifest(dependent, (manifest) => {
    manifest.dsh = { client: { platform: "web", inject: [ADDON] } };
  });
  assert.doesNotThrow(() => new WebAssets(selected));
});

for (const target of [
  "../outside.js",
  "/tmp/outside.js",
  "./lib/../../outside.js",
  "./lib\\outside.js",
]) {
  it(`rejects non-local client export ${target}`, (t) => {
    const { directory, options } = fixture(t);
    editManifest(directory, (manifest) => {
      manifest.exports = { "./client": target };
    });
    assert.throws(
      () => new WebAssets({ ...options, externalPlugins: [{ id: ADDON, directory }] }),
      /package-local/u,
    );
  });
}

for (const resource of ["package.json", "lib/client.js", "lib/client.details.js"]) {
  it(`rejects a ${resource} symlink outside the installed package`, (t) => {
    const { root, directory, options } = fixture(t);
    const target = join(directory, resource);
    const outside = join(root, "outside");
    write(outside, readFileSync(target, "utf8"));
    rmSync(target);
    symlinkSync(outside, target);
    assert.throws(
      () => new WebAssets({ ...options, externalPlugins: [{ id: ADDON, directory }] }),
      /asset escapes/u,
    );
  });
}

it("rejects malformed browser dependency declarations", (t) => {
  const { directory, options } = fixture(t);
  editManifest(directory, (manifest) => {
    manifest.dsh = { client: { platform: "web", external: "react" } };
  });
  assert.throws(
    () => new WebAssets({ ...options, externalPlugins: [{ id: ADDON, directory }] }),
    /array of non-empty strings/u,
  );
});

const THEME = "@deepseek-ai/dsh-client-ui-theme";

function runtimeFixture(t: TestContext): ReturnType<typeof fixture> {
  const base = fixture(t);
  write(join(base.root, "import-manifest.json"), JSON.stringify({ version: "0.2.1-alpha.1" }));
  for (const [name, version, path] of [
    ["react", "18.3.1", "apps/web/node_modules/react"],
    ["react-dom", "18.3.1", "apps/web/node_modules/react-dom"],
    ["@deepseek-ai/cordis", "4.0.5-alpha.1", "vendor/cordis"],
    [THEME, "0.2.1-alpha.1", "packages/client/theme"],
    ["@deepseek-ai/dsh-goal", "0.2.1-alpha.1", "packages/goal/goal"],
  ]) {
    assert.ok(name && version && path);
    write(
      join(base.root, path, "package.json"),
      JSON.stringify({
        name,
        version,
        exports: { "./client": "./lib/client.js", "./package.json": "./package.json" },
        dsh: { client: { platform: "web" } },
      }),
    );
    write(join(base.root, path, "lib/client.js"), "runtime();\n");
  }
  return { ...base, options: { ...base.options, plugins: [BUILTIN, THEME] } };
}

function packOptions(root: string, options: WebAssetOptions): WebAssetOptions {
  const packedRoot = join(root, "distribution/web");
  new WebAssets(options).exportPlugins(packedRoot);
  write(join(packedRoot, "index.html"), SHELL);
  return { packedRoot, plugins: options.plugins, globals: {}, title: "T" };
}

for (const mode of ["source", "packed"] as const) {
  it(`checks shared peers on a ${mode} bundle wrapper without its own client entry`, (t) => {
    const { root, directory, options } = runtimeFixture(t);
    const base = mode === "packed" ? packOptions(root, options) : options;
    editManifest(directory, (manifest) => {
      manifest.dsh = { bundle: { patch: "bundle.yml" } };
      manifest.peerDependencies = { "@deepseek-ai/cordis": "^5.0.0" };
    });
    write(join(directory, "bundle.yml"), "- insert:\n    - id: host\n      name: ./host.js\n");
    assert.throws(
      () => new WebAssets({ ...base, externalPlugins: [{ id: ADDON, directory }] }),
      /requires @deepseek-ai\/cordis@\^5\.0\.0.*provides 4\.0\.5-alpha\.1/,
    );
  });

  it(`checks DSH and singleton peers against the ${mode} Host instead of installed copies`, (t) => {
    const { root, directory, options } = runtimeFixture(t);
    const base = mode === "packed" ? packOptions(root, options) : options;
    editManifest(directory, (manifest) => {
      manifest.engines = { dsh: ">=0.2.1-alpha.1 <0.3.0" };
      manifest.peerDependencies = {
        react: "^18.0.0",
        "react-dom": "^18.0.0",
        "@deepseek-ai/cordis": "*",
        [THEME]: "*",
      };
    });
    // The installer may place different peers beside the extension; none are the browser Host.
    write(
      join(directory, "node_modules/react/package.json"),
      JSON.stringify({ name: "react", version: "19.0.0" }),
    );
    const selected = { ...base, externalPlugins: [{ id: ADDON, directory }] };
    assert.doesNotThrow(() => new WebAssets(selected));
    for (const [name, range, actual] of [
      ["react", "^19.0.0", "18.3.1"],
      ["react-dom", "^19.0.0", "18.3.1"],
      ["@deepseek-ai/cordis", ">=5", "4.0.5-alpha.1"],
      [THEME, ">=0.3.0", "0.2.1-alpha.1"],
    ]) {
      assert.ok(name && range && actual);
      editManifest(directory, (manifest) => {
        manifest.peerDependencies = { [name]: range };
      });
      assert.throws(
        () => new WebAssets(selected),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(`requires ${name}@${range}`));
          assert.ok(error.message.includes(`Host provides ${actual}`));
          return true;
        },
      );
    }
    editManifest(directory, (manifest) => {
      manifest.peerDependencies = {};
      manifest.engines = { dsh: ">=0.3.0" };
    });
    assert.throws(
      () => new WebAssets(selected),
      /requires dsh@>=0\.3\.0.*Host provides 0\.2\.1-alpha\.1/u,
    );
  });

  it(`refuses required DSH peers absent from the ${mode} browser runtime`, (t) => {
    const { root, directory, options } = runtimeFixture(t);
    const base = mode === "packed" ? packOptions(root, options) : options;
    editManifest(directory, (manifest) => {
      manifest.peerDependencies = { "@deepseek-ai/dsh-goal": "^0.2.1-alpha.1" };
    });
    assert.throws(
      () => new WebAssets({ ...base, externalPlugins: [{ id: ADDON, directory }] }),
      /dsh-goal.*Host does not provide @deepseek-ai\/dsh-goal/u,
    );
  });
}

it("exports exact runtime versions and packed validation never resolves host-machine npm peers", (t) => {
  const { root, directory, options } = runtimeFixture(t);
  const packed = packOptions(root, options);
  assert.ok(packed.packedRoot);
  const snapshot = JSON.parse(
    readFileSync(join(packed.packedRoot, CLIENT_RUNTIME_VERSIONS_FILE), "utf8"),
  ) as { dsh: string; packages: Record<string, string> };
  assert.equal(snapshot.dsh, "0.2.1-alpha.1");
  assert.equal(snapshot.packages.react, "18.3.1");
  assert.equal(snapshot.packages["@deepseek-ai/cordis"], "4.0.5-alpha.1");
  assert.equal(snapshot.packages[THEME], "0.2.1-alpha.1");
  assert.equal(snapshot.packages["@deepseek-ai/dsh-goal"], undefined);
  write(
    join(root, "apps/web/node_modules/react/package.json"),
    JSON.stringify({ name: "react", version: "19.0.0" }),
  );
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { react: "^18.0.0" };
  });
  assert.doesNotThrow(
    () => new WebAssets({ ...packed, externalPlugins: [{ id: ADDON, directory }] }),
  );
  assert.throws(
    () => new WebAssets({ ...options, externalPlugins: [{ id: ADDON, directory }] }),
    /Host provides 19\.0\.0/u,
  );
});

it("refuses constrained plugins when a packed distribution has no runtime version snapshot", (t) => {
  const { root, directory, options } = runtimeFixture(t);
  const packed = packOptions(root, options);
  assert.ok(packed.packedRoot);
  rmSync(join(packed.packedRoot, CLIENT_RUNTIME_VERSIONS_FILE));
  const selected = { ...packed, externalPlugins: [{ id: ADDON, directory }] };
  assert.doesNotThrow(() => new WebAssets(selected));
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { react: "^18.0.0" };
  });
  assert.throws(() => new WebAssets(selected), /Host version snapshot is unavailable/u);
  editManifest(directory, (manifest) => {
    delete manifest.peerDependencies;
    manifest.engines = { dsh: ">=0.2.1-alpha.1" };
  });
  assert.throws(() => new WebAssets(selected), /Host version snapshot is unavailable/u);
  assert.doesNotThrow(() => new WebAssets(packed));
});

it("validates ranges with DSH prerelease and workspace rules and respects optional peers", (t) => {
  const { directory, options } = runtimeFixture(t);
  const selected = { ...options, externalPlugins: [{ id: ADDON, directory }] };
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { react: "workspace:*" };
  });
  assert.throws(() => new WebAssets(selected), /invalid react version range/u);
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { "@deepseek-ai/cordis": "^4.0.0" };
  });
  assert.doesNotThrow(() => new WebAssets(selected));
  for (const range of ["workspace:*", "workspace:^", "workspace:~"]) {
    editManifest(directory, (manifest) => {
      manifest.peerDependencies = { [THEME]: range };
    });
    assert.doesNotThrow(() => new WebAssets(selected));
  }
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { "@deepseek-ai/dsh-goal": "^0.2.1-alpha.1" };
    manifest.peerDependenciesMeta = { "@deepseek-ai/dsh-goal": { optional: true } };
  });
  assert.doesNotThrow(() => new WebAssets(selected));
  editManifest(directory, (manifest) => {
    manifest.peerDependencies = { react: "^19.0.0" };
    manifest.peerDependenciesMeta = { react: { optional: true } };
  });
  assert.throws(() => new WebAssets(selected), /Host provides 18\.3\.1/u);
});
