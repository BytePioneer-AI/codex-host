/** Web extension package ownership, activation intent, and script-free installation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  commandInvocation,
  resolveHarnessExecutable,
  withNodeRuntimeOnPath,
} from "@codexhost/harness-discovery";

import { DataDir } from "../src/store.ts";
import { extensionInstallSpec } from "../src/ui-extension-install.ts";
import { WebUiExtensions, type WebUiExtensionsOptions } from "../src/ui-extensions.ts";

const REGISTRY = "ui-extensions/installed.json";
const PACKAGE = "@test/dsh-theme";
const VERSION = "1.2.3";

function item<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  assert.ok(value !== undefined, `Expected item at index ${index}`);
  return value;
}

function dataDir(t: TestContext): DataDir {
  const root = mkdtempSync(join(tmpdir(), "codexhost-ui-extensions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new DataDir(root);
}

/** Fixtures model installer output; they are not third-party compatibility samples. */
function writeInstalledPackage(
  directory: string,
  {
    name = PACKAGE,
    version = VERSION,
    manifestName = name,
  }: {
    name?: string;
    version?: string;
    manifestName?: string;
  } = {},
): void {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { [name]: version } }),
  );
  const packageDir = join(directory, "node_modules", name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: manifestName, version }));
  writeFileSync(
    join(packageDir, "client.js"),
    "throw new Error('Package code must not be evaluated');\n",
  );
}

function extensions(data: DataDir, options: Partial<WebUiExtensionsOptions> = {}): WebUiExtensions {
  return new WebUiExtensions(data, {
    installPackage: async (directory) => writeInstalledPackage(directory),
    validate: () => undefined,
    ...options,
  });
}

function installedDirectories(data: DataDir): string[] {
  const directory = data.path("ui-extensions", "packages");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

it("derives project links for existing installations without persisting metadata", async (t) => {
  const data = dataDir(t);
  const store = extensions(data);
  await store.install(PACKAGE);
  assert.equal(item(store.state().extensions).projectUrl, undefined);
  const plugin = item(store.plugins(false));
  writeFileSync(
    join(plugin.directory, "package.json"),
    JSON.stringify({ name: PACKAGE, version: VERSION, repository: "github:author/theme" }),
  );
  assert.equal(
    item(extensions(data).state().extensions).projectUrl,
    "https://github.com/author/theme",
  );
  assert.equal(readFileSync(data.path(REGISTRY), "utf8").includes("projectUrl"), false);
  rmSync(join(plugin.directory, "package.json"));
  assert.equal(item(store.state().extensions).projectUrl, undefined);
});

it("exposes DSH metadata without persisting it or blocking management on an icon error", async (t) => {
  const data = dataDir(t);
  const store = extensions(data);
  await store.install(PACKAGE);
  const plugin = item(store.plugins(false));
  writeFileSync(
    join(plugin.directory, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      description: "A package description",
      icon: "https://example.com/icon.svg",
      exports: { "./package.json": "./package.json" },
    }),
  );
  const meta = item(extensions(data).state().extensions).meta;
  assert.equal(meta?.description, "A package description");
  assert.ok(meta?.error);
  assert.equal(item(store.state().extensions).loadError, undefined);
  assert.equal(readFileSync(data.path(REGISTRY), "utf8").includes('"meta"'), false);
  assert.deepEqual(item((await store.setEnabled(PACKAGE, true)).extensions).enabledTargets, [
    "web",
  ]);
  await store.remove(PACKAGE);
  assert.deepEqual(store.state().extensions, []);
});

it("retains running installation files until release and cleans removed packages at startup", async (t) => {
  const data = dataDir(t);
  const store = extensions(data);
  await store.install(`${PACKAGE}@${VERSION}`);
  await store.setEnabled(PACKAGE, true);
  store.composed([PACKAGE]);
  const directory = item(store.plugins()).directory;
  await store.remove(PACKAGE);
  assert.deepEqual(store.state().extensions, []);
  assert.deepEqual(store.state().loadedIds, [PACKAGE]);
  await store.cleanup();
  assert.ok(existsSync(directory));
  await store.cleanup(true);
  assert.equal(existsSync(directory), false);

  await store.install(`${PACKAGE}@${VERSION}`);
  store.composed([PACKAGE]);
  const abandoned = item(store.plugins(false)).directory;
  await store.remove(PACKAGE);
  await extensions(data).cleanup();
  assert.equal(existsSync(abandoned), false);
});

it("accepts npm names, exact versions, tags, ranges, and existing absolute package paths", async (t) => {
  for (const spec of ["simple-theme@1.0.0", "@test/dsh-theme@1.2.3-rc.1+build.2"]) {
    const separator = spec.lastIndexOf("@");
    assert.deepEqual(await extensionInstallSpec(`  ${spec}  `), {
      spec,
      expected: { name: spec.slice(0, separator), version: spec.slice(separator + 1) },
    });
  }
  for (const spec of [
    "simple-theme",
    "simple-theme@latest",
    "simple-theme@^1.0.0",
    "@test/dsh-theme@next",
  ]) {
    const name = spec.slice(0, spec.indexOf("@", 1) === -1 ? undefined : spec.indexOf("@", 1));
    assert.deepEqual(await extensionInstallSpec(spec), { spec, expected: { name } });
  }
  const archive = dataDir(t).path("theme.tgz");
  writeFileSync(archive, "archive bytes are validated by the installer");
  assert.deepEqual(await extensionInstallSpec(archive), { spec: archive });
  const directory = dataDir(t).path("theme-directory");
  mkdirSync(directory);
  assert.deepEqual(await extensionInstallSpec(directory), { spec: directory });
  assert.deepEqual(await extensionInstallSpec(`file:${directory}`), {
    spec: `file:${directory}`,
    installSpec: directory,
  });
});

it("rejects unsupported hosts, aliases, relative paths, and missing or non-file archives", async (t) => {
  const data = dataDir(t);
  const directory = data.path("directory.tgz");
  mkdirSync(directory);
  for (const spec of [
    "theme@01.0.0",
    "theme@",
    "theme@file:/tmp/theme",
    "theme@npm:other-theme",
    "https://example.com/theme.tgz",
    "git+https://example.com/theme.git",
    "file:./theme.tgz",
    "./theme.tgz",
    "--ignore-scripts=false",
    "theme@1.0.0\nother@1.0.0",
    data.path("missing.tgz"),
    data.path("theme.tar.gz"),
    directory,
  ]) {
    await assert.rejects(extensionInstallSpec(spec), spec);
  }
});

it("fetches public GitHub repositories as archives without npm Git preparation", async () => {
  for (const spec of [
    "https://github.com/author/theme",
    "https://github.com/author/theme/",
    "git+https://github.com/author/theme.git",
    "github:author/theme",
    "git@github.com:author/theme.git",
  ]) {
    assert.deepEqual(await extensionInstallSpec(spec), {
      spec,
      installSpec: "https://codeload.github.com/author/theme/tar.gz/HEAD",
    });
  }
  assert.equal(
    (await extensionInstallSpec("https://github.com/author/theme#feature/ui")).installSpec,
    "https://codeload.github.com/author/theme/tar.gz/feature%2Fui",
  );
  for (const spec of [
    "https://user:password@github.com/author/theme",
    "https://github.com/author/theme?token=secret",
    "https://github.com:443/author/theme#bad%00ref",
    "github:author/theme#semver:^1.0.0",
  ]) {
    await assert.rejects(extensionInstallSpec(spec), spec);
  }
});

it("passes the selected registry and records resolved versions for package names and tags", async (t) => {
  for (const spec of [PACKAGE, `${PACKAGE}@latest`, `${PACKAGE}@^1.0.0`]) {
    const data = dataDir(t);
    const store = extensions(data, {
      installPackage: async (directory, source, registry) => {
        assert.equal(source, spec);
        assert.equal(registry, "https://npm.example.com/packages/");
        writeInstalledPackage(directory);
      },
    });
    const state = await store.install(spec, "https://NPM.example.com/packages");
    assert.equal(item(state.extensions).version, VERSION);
    assert.equal(item(state.extensions).source, spec);
  }
  const data = dataDir(t);
  const store = extensions(data, {
    installPackage: async (directory) =>
      writeInstalledPackage(directory, { name: "unexpected-theme" }),
  });
  await assert.rejects(store.install(PACKAGE), /does not match/u);
  assert.deepEqual(store.state().extensions, []);
});

it("installs disabled, validates assets without importing code, and persists across reopening", async (t) => {
  const data = dataDir(t);
  const checked: string[][] = [];
  const store = extensions(data, {
    validate: (plugins) => {
      checked.push(plugins.map((plugin) => plugin.id));
      assert.ok(existsSync(join(item(plugins).directory, "client.js")));
    },
  });
  const state = await store.install(`${PACKAGE}@${VERSION}`);
  assert.equal(state.extensions.length, 1);
  assert.deepEqual(state.extensions[0], {
    id: PACKAGE,
    name: PACKAGE,
    version: VERSION,
    format: "dsh",
    supportedTargets: ["web"],
    enabledTargets: [],
    source: `${PACKAGE}@${VERSION}`,
    installedAt: item(state.extensions).installedAt,
    meta: { title: PACKAGE },
  });
  assert.ok(Number.isFinite(Date.parse(item(state.extensions).installedAt)));
  assert.deepEqual(checked, [[PACKAGE]]);
  assert.deepEqual(store.plugins(), []);
  assert.deepEqual(state.loadedIds, []);
  assert.ok(existsSync(join(item(store.plugins(false)).directory, "client.js")));
  assert.deepEqual(extensions(data).state(), state);
  assert.equal(installedDirectories(data).length, 1);
});

it("persists activation intent, rejects invalid activation, and lets a broken plugin be disabled", async (t) => {
  const data = dataDir(t);
  let invalid = false;
  const store = extensions(data, {
    validate: () => {
      if (invalid) throw new Error("Missing client dependency");
    },
  });
  await store.install(`${PACKAGE}@${VERSION}`);
  invalid = true;
  const before = readFileSync(data.path(REGISTRY), "utf8");
  await assert.rejects(store.setEnabled(PACKAGE, true), /Missing client dependency/u);
  assert.equal(readFileSync(data.path(REGISTRY), "utf8"), before);
  assert.deepEqual(store.plugins(), []);
  invalid = false;
  await store.setEnabled(PACKAGE, true);
  assert.deepEqual(item(extensions(data).state().extensions).enabledTargets, ["web"]);
  assert.equal(store.plugins().length, 1);
  invalid = true;
  await store.setEnabled(PACKAGE, false);
  assert.deepEqual(item(extensions(data).state().extensions).enabledTargets, []);
  await assert.rejects(store.setEnabled("missing-theme", true), /not installed/u);
});

it("removes the selected package and keeps another installation intact", async (t) => {
  const data = dataDir(t);
  let name = PACKAGE;
  const store = extensions(data, {
    installPackage: async (directory) => writeInstalledPackage(directory, { name }),
  });
  await store.install(`${PACKAGE}@${VERSION}`);
  const removedPath = item(store.plugins(false)).directory;
  name = "other-theme";
  await store.install(`${name}@${VERSION}`);
  const keptPath = item(store.plugins(false), 1).directory;
  await store.remove(PACKAGE);
  assert.equal(existsSync(removedPath), false);
  assert.ok(existsSync(keptPath));
  assert.deepEqual(
    extensions(data)
      .state()
      .extensions.map((entry) => entry.id),
    [name],
  );
  await assert.rejects(store.remove(PACKAGE), /not installed/u);
});

it("allows installing a healthy package after disabling a broken retained extension", async (t) => {
  const data = dataDir(t);
  let name = PACKAGE;
  const validated: string[][] = [];
  const store = extensions(data, {
    installPackage: async (directory) => writeInstalledPackage(directory, { name }),
    validate: (plugins) => {
      validated.push(plugins.map((plugin) => plugin.id));
      for (const plugin of plugins) {
        if (readFileSync(join(plugin.directory, "client.js"), "utf8") === "invalid") {
          throw new Error(`Invalid client assets: ${plugin.id}`);
        }
      }
    },
  });
  await store.install(`${PACKAGE}@${VERSION}`);
  await store.setEnabled(PACKAGE, true);
  const brokenFile = join(item(store.plugins()).directory, "client.js");
  writeFileSync(brokenFile, "invalid");
  name = "healthy-theme";
  await assert.rejects(store.install(`${name}@${VERSION}`), /Invalid client assets/u);
  await store.setEnabled(PACKAGE, false);
  const state = await store.install(`${name}@${VERSION}`);
  assert.deepEqual(validated.at(-1), [name]);
  assert.deepEqual(
    state.extensions.map((entry) => entry.id),
    [PACKAGE, name],
  );
  assert.deepEqual(item(state.extensions).enabledTargets, []);
  assert.equal(readFileSync(brokenFile, "utf8"), "invalid");
  assert.equal(installedDirectories(data).length, 2);
  assert.deepEqual(extensions(data).state(), state);
});

it("rolls back failed package validation and partial installs without altering earlier entries", async (t) => {
  for (const failure of ["manifest", "version", "assets", "installer", "dependencies"] as const) {
    await t.test(failure, async (caseContext) => {
      const data = dataDir(caseContext);
      let fail = false;
      const store = extensions(data, {
        installPackage: async (directory) => {
          writeInstalledPackage(directory, {
            name: fail ? "other-theme" : PACKAGE,
            manifestName:
              fail && failure === "manifest" ? "wrong-theme" : fail ? "other-theme" : PACKAGE,
            version: fail && failure === "version" ? "9.9.9" : VERSION,
          });
          if (fail && failure === "installer") throw new Error("Installer stopped");
          if (fail && failure === "dependencies") {
            writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: {} }));
          }
        },
        validate: () => {
          if (fail && failure === "assets") throw new Error("Invalid client assets");
        },
      });
      await store.install(`${PACKAGE}@${VERSION}`);
      const saved = readFileSync(data.path(REGISTRY), "utf8");
      const directories = installedDirectories(data);
      fail = true;
      await assert.rejects(store.install(`other-theme@${VERSION}`));
      assert.equal(readFileSync(data.path(REGISTRY), "utf8"), saved);
      assert.deepEqual(installedDirectories(data), directories);
      assert.equal(store.state().extensions.length, 1);
    });
  }
});

it("serializes duplicate installs and keeps the first package without abandoned staging directories", async (t) => {
  const data = dataDir(t);
  const store = extensions(data);
  const results = await Promise.allSettled([
    store.install(`${PACKAGE}@${VERSION}`),
    store.install(`${PACKAGE}@${VERSION}`),
  ]);
  assert.equal(item(results).status, "fulfilled");
  const rejected = item(results, 1);
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") assert.match(String(rejected.reason), /already installed/u);
  assert.equal(store.state().extensions.length, 1);
  assert.equal(installedDirectories(data).length, 1);
  await store.setEnabled(PACKAGE, true);
  assert.deepEqual(item(store.state().extensions).enabledTargets, ["web"]);
});

it("preserves a corrupt registry and blocks every mutation before installing a package", async (t) => {
  const data = dataDir(t);
  const initial = extensions(data);
  await initial.install(`${PACKAGE}@${VERSION}`);
  const valid = JSON.parse(readFileSync(data.path(REGISTRY), "utf8")) as { extensions: unknown[] };
  for (const raw of [
    "{broken",
    JSON.stringify({ version: 2, extensions: [] }),
    JSON.stringify({
      version: 1,
      extensions: [valid.extensions[0], valid.extensions[0]],
    }),
  ]) {
    writeFileSync(data.path(REGISTRY), raw);
    let installCalls = 0;
    const broken = extensions(data, {
      installPackage: async () => {
        installCalls++;
      },
    });
    assert.match(broken.state().storeError ?? "", /registry is invalid/u);
    for (const mutation of [
      () => broken.install(`${PACKAGE}@${VERSION}`),
      () => broken.setEnabled(PACKAGE, false),
      () => broken.remove(PACKAGE),
    ])
      await assert.rejects(mutation(), /registry is invalid/u);
    assert.equal(installCalls, 0);
    assert.equal(readFileSync(data.path(REGISTRY), "utf8"), raw);
  }
});

it("reports composition failures separately from saved enablement and safe mode", async (t) => {
  const data = dataDir(t);
  const store = extensions(data, { safeMode: true });
  await store.install(`${PACKAGE}@${VERSION}`);
  await store.setEnabled(PACKAGE, true);
  store.composed([], "Missing runtime dependency");
  assert.equal(store.state().safeMode, true);
  assert.deepEqual(store.state().loadedIds, []);
  assert.equal(item(store.state().extensions).loadError, "Missing runtime dependency");
  assert.deepEqual(item(store.state().extensions).enabledTargets, ["web"]);
  assert.equal(item(extensions(data).state().extensions).loadError, undefined);
  store.composed([PACKAGE]);
  assert.deepEqual(store.state().loadedIds, [PACKAGE]);
  assert.equal(item(store.state().extensions).loadError, undefined);
});

it("uses real offline npm to install a local archive without running lifecycle scripts", async (t) => {
  const data = dataDir(t);
  const fixture = data.path("fixture");
  mkdirSync(fixture);
  const marker = data.path("lifecycle-ran");
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      scripts: {
        preinstall: "node lifecycle.cjs",
        install: "node lifecycle.cjs",
        postinstall: "node lifecycle.cjs",
        prepare: "node lifecycle.cjs",
      },
    }),
  );
  writeFileSync(
    join(fixture, "lifecycle.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  const overrides = {
    npm_config_cache: data.path("npm-cache"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "false",
  };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = previous;
    });
  }
  const environment = withNodeRuntimeOnPath(process.env);
  const npm = resolveHarnessExecutable(
    { id: "npm", command: process.platform === "win32" ? "npm.cmd" : "npm" },
    { environment },
  );
  assert.ok(npm);
  const invocation = commandInvocation(
    npm.executable,
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", fixture],
    environment,
  );
  const packed = await promisify(execFile)(invocation.command, invocation.arguments, {
    cwd: fixture,
    env: environment,
    timeout: 30_000,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const { filename } = item(JSON.parse(packed.stdout) as Array<{ filename: string }>);
  const store = new WebUiExtensions(data, { validate: () => undefined });
  await store.install(join(fixture, filename));
  assert.equal(existsSync(marker), false, "npm lifecycle hooks must never execute");
  assert.equal(item(store.state().extensions).id, PACKAGE);
  assert.deepEqual(item(store.state().extensions).enabledTargets, []);
  assert.ok(existsSync(join(item(store.plugins(false)).directory, "lifecycle.cjs")));
});

it("copies local directories and suppresses lifecycle scripts inside Git dependency preparation", async (t) => {
  const data = dataDir(t);
  const fixture = data.path("source-theme");
  const dependency = data.path("git-dependency");
  const hooks = data.path("empty-hooks");
  mkdirSync(fixture);
  mkdirSync(dependency);
  mkdirSync(hooks);
  const marker = data.path("lifecycle-ran");
  const scripts = Object.fromEntries(
    ["preinstall", "install", "postinstall", "prepare", "prepack"].map((name) => [
      name,
      "node lifecycle.cjs",
    ]),
  );
  for (const directory of [fixture, dependency]) {
    writeFileSync(
      join(directory, "lifecycle.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
  }
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({ name: "fixture-git-dependency", version: "1.0.0", scripts }),
  );
  const git = async (...args: string[]) =>
    promisify(execFile)(
      "git",
      [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "user.name=CodexHost Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dependency, timeout: 30_000 },
    );
  await git("init", "--template=", "--initial-branch=main");
  await git("add", "package.json", "lifecycle.cjs");
  await git("commit", "-m", "fixture");
  const { stdout: commit } = await git("rev-parse", "HEAD");
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: VERSION,
      scripts,
      dependencies: {
        "fixture-git-dependency": `git+${pathToFileURL(dependency).href}#${commit.trim()}`,
      },
    }),
  );
  writeFileSync(join(fixture, "client.js"), "original client bytes");
  for (const [key, value] of Object.entries({
    npm_config_cache: data.path("npm-cache"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = previous;
    });
  }
  const store = new WebUiExtensions(data, { validate: () => undefined });
  await store.install(fixture);
  assert.equal(
    existsSync(marker),
    false,
    "Git dependency prepare must not run scripts in a nested npm process",
  );
  const installed = item(store.plugins(false)).directory;
  writeFileSync(join(fixture, "client.js"), "changed after install");
  assert.equal(readFileSync(join(installed, "client.js"), "utf8"), "original client bytes");
  rmSync(fixture, { recursive: true });
  rmSync(dependency, { recursive: true });
  assert.equal(readFileSync(join(installed, "client.js"), "utf8"), "original client bytes");
  assert.equal(item(store.state().extensions).source, fixture);
});
