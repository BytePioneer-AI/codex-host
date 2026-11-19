import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { packKoffiBinding } from "../src/pack-koffi.ts";

function fixture(t: TestContext, platform = "win32", architecture = "arm64") {
  const root = mkdtempSync(join(tmpdir(), "pack-koffi-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = `@koromix/koffi-${platform}-${architecture}`;
  const version = "3.1.1";
  const source = join(root, "package");
  const binary = `${platform}_${architecture}/koffi.node`;
  mkdirSync(join(source, `${platform}_${architecture}`), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(source, binary), "target native binding");
  execFileSync("tar", ["-czf", "binding.tgz", "package"], { cwd: root });
  const archive = readFileSync(join(root, "binding.tgz"));
  const artifact = {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/koffi-${platform}-${architecture}-${version}.tgz`,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  };
  const lock = {
    packages: {
      "node_modules/koffi": { version, optionalDependencies: { [name]: version } },
      [`node_modules/${name}`]: artifact,
    },
  };
  const saveLock = () => writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
  saveLock();
  const dependencies = join(root, "output/node_modules");
  const options = { root, dependencies, platform, architecture };
  return { root, name, source, binary, archive, artifact, saveLock, dependencies, options };
}

it("packages a missing Windows ARM64 binding from the locked archive without changing node_modules", async (t) => {
  const f = fixture(t);
  let requests = 0;
  await packKoffiBinding({
    ...f.options,
    fetch: async (url) => {
      requests++;
      assert.equal(url, f.artifact.resolved);
      return new Response(f.archive);
    },
  });
  assert.equal(requests, 1);
  assert.equal(
    readFileSync(join(f.dependencies, f.name, f.binary), "utf8"),
    "target native binding",
  );
  assert.equal(existsSync(join(f.root, "node_modules", f.name)), false);
});

it("reuses the installed target binding without a network request", async (t) => {
  const f = fixture(t);
  cpSync(f.source, join(f.root, "node_modules", f.name), { recursive: true });
  await packKoffiBinding({
    ...f.options,
    fetch: async () => {
      throw new Error("must not download an installed binding");
    },
  });
  assert.equal(existsSync(join(f.dependencies, f.name, f.binary)), true);
});

it("rejects a corrupted download before extracting or packaging it", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    packKoffiBinding({ ...f.options, fetch: async () => new Response("corrupted") }),
    /SHA-512 verification failed/u,
  );
  assert.equal(existsSync(join(f.dependencies, f.name)), false);
});

it("reports download failures instead of emitting an incomplete package", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    packKoffiBinding({ ...f.options, fetch: async () => new Response(null, { status: 404 }) }),
    /HTTP 404/u,
  );
  assert.equal(existsSync(join(f.dependencies, f.name)), false);
});

for (const invalid of ["version", "registry"] as const) {
  it(`rejects a locked binding with a mismatched ${invalid}`, async (t) => {
    const f = fixture(t);
    if (invalid === "version") f.artifact.version = "0.0.1";
    else f.artifact.resolved = "https://mirror.invalid/binding.tgz";
    f.saveLock();
    await assert.rejects(packKoffiBinding(f.options), /Invalid locked Koffi artifact/u);
  });
}

it("rejects an installed binding with the wrong package identity", async (t) => {
  const f = fixture(t);
  const installed = join(f.root, "node_modules", f.name);
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: f.name, version: "0.0.1" }),
  );
  await assert.rejects(packKoffiBinding(f.options), /package metadata mismatch/u);
});

it("rejects unsupported target names before reading the lockfile", async () => {
  await assert.rejects(
    packKoffiBinding({
      root: "unused",
      dependencies: "unused",
      platform: "../win32",
      architecture: "arm64",
    }),
    /Unsupported Koffi release target/u,
  );
});
