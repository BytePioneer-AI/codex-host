import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type * as FsPromises from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ diskFull: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async writeFile(...args: Parameters<typeof FsPromises.writeFile>) {
      if (io.diskFull && String(args[0]).endsWith("offline-user.npmrc"))
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      return actual.writeFile(...args);
    },
  };
});
afterEach(() => {
  io.diskFull = false;
});

import {
  offlineNpmArguments,
  prepareNpmMaterials,
  type PreparedNpmMaterials,
} from "../src/npm-materials.js";
import { createNpmFixture } from "./npm-fixture.js";

const execute = promisify(execFile);
let fixture: Awaited<ReturnType<typeof createNpmFixture>>;
let root: string;
let archives: Awaited<ReturnType<typeof fixture.publish>>;
let unrelated: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-npm-"));
  fixture = await createNpmFixture(root);
  archives = await fixture.publish("1.2.2");
  await fixture.publish("1.2.3");
  await fixture.publish("1.2.4");
  await fixture.pack(
    { name: "@codexhost/unrelated-optional", version: "9.0.0" },
    { "keep.txt": "optional dependency data" },
  );
  unrelated = await fixture.pack(
    {
      name: "@codexhost/unrelated-fixture",
      version: "9.0.0",
      optionalDependencies: { "@codexhost/unrelated-optional": "9.0.0" },
    },
    { "keep.txt": "unrelated package data" },
  );
}, 60_000);
afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function snapshot(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string) {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name);
      const info = await lstat(file);
      const relative = path.relative(directory, file);
      if (info.isSymbolicLink()) result.push(`${relative}:link:${await readlink(file)}`);
      else if (info.isDirectory()) await walk(file);
      else
        result.push(
          `${relative}:${createHash("sha256")
            .update(await readFile(file))
            .digest("hex")}`,
        );
    }
  }
  await walk(directory);
  return result;
}
async function installation(normalRegistry = false) {
  fixture.state.denyNetwork = false;
  fixture.state.corruptIntegrity = false;
  fixture.state.missingPlatform = false;
  fixture.state.delayMs = 0;
  const work = await mkdtemp(path.join(root, "operation-"));
  const prefix = path.join(work, "当前 中文 prefix");
  await mkdir(prefix);
  const otherPrefix = path.join(work, "other-prefix");
  await mkdir(otherPrefix);
  await writeFile(path.join(otherPrefix, "keep"), "other installation");
  await fixture.run([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--cache",
    path.join(work, "seed-cache"),
    ...(normalRegistry ? [] : ["--offline", "--omit=optional"]),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--",
    ...(normalRegistry
      ? ["@codexhost/cli@1.2.2", "@codexhost/unrelated-fixture@9.0.0"]
      : [archives.cli, archives.platform, unrelated]),
  ]);
  await writeFile(path.join(prefix, "user.keep"), "user data");
  return { work, prefix, otherPrefix };
}
async function prepare(work: string, prefix: string, version = "1.2.3", timeoutMs?: number) {
  const operation = path.join(work, `version-${version}`);
  await mkdir(operation, { recursive: true });
  return prepareNpmMaterials(
    {
      nodePath: fixture.nodePath,
      npmCliPath: fixture.npmCliPath,
      version,
      platform: process.platform,
      architecture: process.arch,
      directory: path.join(operation, version === "1.2.2" ? "npm-previous" : "npm"),
      installPrefix: prefix,
    },
    { environment: fixture.environment, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
}
async function install(materials: PreparedNpmMaterials, prefix: string, otherPrefix: string) {
  const args = offlineNpmArguments(materials, prefix);
  expect(args).toContain("--offline");
  expect(args).not.toContain("--prefer-offline");
  const native = process.env.CODEXHOST_NATIVE_UPDATER_TEST_BINARY;
  if (native) {
    const hook = path.join(path.dirname(materials.cli.path), "unexpected-preload.cjs");
    const marker = path.join(prefix, "preload-ran");
    await writeFile(
      hook,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected");`,
    );
    const request = path.join(path.dirname(materials.cli.path), "native-fixture-request.json");
    await writeFile(
      request,
      JSON.stringify({
        operation: path.dirname(path.dirname(materials.cli.path)),
        node: fixture.nodePath,
        npm: fixture.npmCliPath,
        prefix,
        materials,
        recovery: path.basename(path.dirname(materials.cli.path)) === "npm-previous",
      }),
    );
    await execute(
      native,
      [
        "--exact",
        "npm_prepared::tests::installs_real_prepared_npm_fixture",
        "--ignored",
        "--nocapture",
      ],
      {
        env: {
          ...fixture.environment,
          CODEXHOST_NPM_FIXTURE_REQUEST: request,
          npm_config_prefix: otherPrefix,
          npm_config_dry_run: "true",
          NODE_OPTIONS: `--require=${JSON.stringify(hook)}`,
        },
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      },
    );
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await fixture.run(args, path.dirname(materials.cli.path), {
      ...fixture.environment,
      npm_config_prefix: otherPrefix,
    });
  }
}

it("prepares without touching the prefix, installs exact successive versions offline and restores the old native npm materials", async () => {
  const { work, prefix, otherPrefix } = await installation();
  const before = await snapshot(prefix);
  const other = await snapshot(otherPrefix);
  const unrelatedBefore = await snapshot(
    path.join(fixture.modules(prefix), "@codexhost/unrelated-fixture"),
  );
  const old = await prepare(work, prefix, "1.2.2");
  const target = await prepare(work, prefix, "1.2.3");
  const next = await prepare(work, prefix, "1.2.4");
  expect(await snapshot(prefix)).toEqual(before);
  const requests = fixture.requests.length;
  fixture.state.denyNetwork = true;
  for (const [materials, version] of [
    [target, "1.2.3"],
    [next, "1.2.4"],
    [old, "1.2.2"],
  ] as const) {
    if (version === "1.2.2") {
      await writeFile(
        path.join(fixture.modules(prefix), "@codexhost/cli/bin/codexhost.js"),
        "partial CLI replacement",
      );
      await writeFile(
        path.join(fixture.modules(prefix), fixture.platformName, "package.json"),
        "{partial package metadata",
      );
      await rm(path.join(fixture.modules(prefix), fixture.platformName, "app/host-runtime.mjs"));
    }
    await install(materials, prefix, otherPrefix);
    expect(await fixture.cliVersion(prefix)).toBe(version);
    expect(await fixture.packageVersion(prefix, fixture.platformName)).toBe(version);
    expect(await fixture.packageVersion(prefix, "@codexhost/unrelated-fixture")).toBe("9.0.0");
    expect(
      await snapshot(path.join(fixture.modules(prefix), "@codexhost/unrelated-fixture")),
    ).toEqual(unrelatedBefore);
    expect(
      await readFile(
        path.join(fixture.modules(prefix), fixture.platformName, "app/host-runtime.mjs"),
        "utf8",
      ),
    ).toBe("fixture");
    expect(await readFile(path.join(prefix, "user.keep"), "utf8")).toBe("user data");
    expect(await snapshot(otherPrefix)).toEqual(other);
  }
  expect(fixture.requests.length).toBe(requests);
}, 60_000);

it.each(["missing", "integrity", "timeout", "disk-full"] as const)(
  "fails before installation when preparation has %s failure",
  async (failure) => {
    const { work, prefix } = await installation();
    const before = await snapshot(prefix);
    fixture.state.missingPlatform = failure === "missing";
    fixture.state.corruptIntegrity = failure === "integrity";
    fixture.state.delayMs = failure === "timeout" ? 5_000 : 0;
    io.diskFull = failure === "disk-full";
    const error =
      failure === "missing"
        ? /E404|not published|not found/iu
        : failure === "integrity"
          ? /integrity/iu
          : failure === "timeout"
            ? /timed out/iu
            : /disk full/iu;
    await expect(
      prepare(work, prefix, "1.2.3", failure === "timeout" ? 600 : undefined),
    ).rejects.toThrow(error);
    expect(await snapshot(prefix)).toEqual(before);
    expect(await fixture.cliVersion(prefix)).toBe("1.2.2");
    await expect(lstat(path.join(work, "version-1.2.3", "npm"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  20_000,
);

it.each(["missing-core", "extra-dependency"] as const)(
  "rejects a published package with incomplete closure: %s",
  async (mode) => {
    const { work, prefix } = await installation();
    const before = await snapshot(prefix);
    const version = mode === "missing-core" ? "1.2.8" : "1.2.9";
    await fixture.publish(version, mode);
    await expect(prepare(work, prefix, version)).rejects.toThrow(
      mode === "missing-core"
        ? /missing app\/host-runtime/iu
        : /unsupported required installation materials/iu,
    );
    expect(await snapshot(prefix)).toEqual(before);
  },
  20_000,
);

it("refuses to stage in the current prefix, including an existing parent alias", async () => {
  const { work, prefix } = await installation();
  const before = await snapshot(prefix);
  const alias = path.join(work, "linked-prefix");
  await symlink(prefix, alias, process.platform === "win32" ? "junction" : "dir");
  for (const base of [prefix, alias])
    await expect(
      prepareNpmMaterials(
        {
          nodePath: fixture.nodePath,
          npmCliPath: fixture.npmCliPath,
          version: "1.2.3",
          platform: process.platform,
          architecture: process.arch,
          directory: path.join(base, "new-materials"),
          installPrefix: prefix,
        },
        { environment: fixture.environment },
      ),
    ).rejects.toThrow("outside");
  expect(await snapshot(prefix)).toEqual(before);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps the old prefix intact on a real staging filesystem write failure",
  async () => {
    const { work, prefix } = await installation();
    const before = await snapshot(prefix);
    const operation = path.join(work, "version-1.2.3");
    await mkdir(operation);
    await chmod(operation, 0o500);
    try {
      await expect(prepare(work, prefix)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(operation, 0o700);
    }
    expect(await snapshot(prefix)).toEqual(before);
  },
);

it("upgrades a normal registry-created nested platform and preserves unrelated optional dependencies offline", async () => {
  const { work, prefix, otherPrefix } = await installation(true);
  const cli = path.join(fixture.modules(prefix), "@codexhost/cli/bin/codexhost.js");
  const resolvePlatform = async () =>
    (
      await execute(
        fixture.nodePath,
        [
          "--input-type=module",
          "-e",
          `import {createRequire} from 'node:module';console.log(createRequire(${JSON.stringify(cli)}).resolve(${JSON.stringify(`${fixture.platformName}/package.json`)}))`,
        ],
        { env: fixture.environment, encoding: "utf8", timeout: 10_000 },
      )
    ).stdout.trim();
  expect(await resolvePlatform()).toContain(
    path.join("@codexhost", "cli", "node_modules", fixture.platformName),
  );
  const unrelatedRoot = path.join(fixture.modules(prefix), "@codexhost/unrelated-fixture");
  const optional = createRequire(path.join(unrelatedRoot, "package.json")).resolve(
    "@codexhost/unrelated-optional/package.json",
  );
  const optionalBefore = await snapshot(path.dirname(optional));
  const unrelatedBefore = await snapshot(unrelatedRoot);
  const target = await prepare(work, prefix);
  const requestCount = fixture.requests.length;
  fixture.state.denyNetwork = true;
  await install(target, prefix, otherPrefix);
  expect(await realpath(await resolvePlatform())).toBe(
    await realpath(path.join(fixture.modules(prefix), fixture.platformName, "package.json")),
  );
  expect(await fixture.packageVersion(prefix, fixture.platformName)).toBe("1.2.3");
  expect(await fixture.cliVersion(prefix)).toBe("1.2.3");
  expect(await snapshot(unrelatedRoot)).toEqual(unrelatedBefore);
  expect(await snapshot(path.dirname(optional))).toEqual(optionalBefore);
  expect(fixture.requests.slice(requestCount)).toEqual([]);
}, 30_000);

it.skipIf(!process.env.CODEXHOST_NATIVE_UPDATER_TEST_BINARY)(
  "preserves remaining recovery materials and the current prefix when original-channel repair is blocked",
  async () => {
    const { work, prefix, otherPrefix } = await installation();
    const old = await prepare(work, prefix, "1.2.2");
    const target = await prepare(work, prefix);
    fixture.state.denyNetwork = true;
    await install(target, prefix, otherPrefix);
    await writeFile(
      path.join(fixture.modules(prefix), fixture.platformName, "package.json"),
      "{partial replacement",
    );
    const before = await snapshot(prefix);
    await rm(old.platform.path);
    await expect(install(old, prefix, otherPrefix)).rejects.toThrow();
    expect(await snapshot(prefix)).toEqual(before);
    expect((await lstat(old.cli.path)).isFile()).toBe(true);
    expect((await lstat(old.cache_path)).isDirectory()).toBe(true);
  },
  20_000,
);

it("uses only local archives even with an empty offline cache", async () => {
  const { work, prefix, otherPrefix } = await installation();
  const target = await prepare(work, prefix);
  const requests = fixture.requests.length;
  fixture.state.denyNetwork = true;
  await rm(target.cache_path, { recursive: true });
  await mkdir(target.cache_path);
  await install(target, prefix, otherPrefix);
  expect(await fixture.packageVersion(prefix, fixture.platformName)).toBe("1.2.3");
  expect(fixture.requests.slice(requests)).toEqual([]);
}, 20_000);
