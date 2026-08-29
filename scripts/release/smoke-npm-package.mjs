import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyLinuxGlibcBaseline } from "./linux-glibc.mjs";
import {
  NPM_PLATFORM_PACKAGE_NAMES,
  npmTarballFileName,
  packNpmPackage,
  prepareNpmPackage,
} from "./prepare-npm.mjs";
import {
  npmMetaTarballFileName,
  packNpmMetaPackage,
  prepareNpmMetaPackage,
} from "./prepare-npm-meta.mjs";
import { releaseTarget } from "./targets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const executablePaths = ["bin/codexhost", "libexec/codexhost-shim", "libexec/codexhost-updater"];

function requireArgument(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || index + 1 >= arguments_.length) {
    throw new Error(`${name} is required`);
  }
  return arguments_[index + 1];
}

export async function smokeNpmPackage({ targetName, version, workDirectory }) {
  const target = releaseTarget(targetName);
  if (target.hostPlatform !== process.platform) {
    throw new Error(`${targetName} package smoke requires ${target.hostPlatform}`);
  }
  const platform = await prepareNpmPackage({ root, target, version, skipBuild: false });
  if (target.hostPlatform === "linux") {
    for (const result of verifyLinuxGlibcBaseline({ packageRoot: platform.packageRoot })) {
      console.log(`${result.relative}: GLIBC_${result.maximum}`);
    }
  }
  const platformTarball = await packNpmPackage({
    packageRoot: platform.packageRoot,
    outputRoot: platform.outputRoot,
    version: platform.version,
    target,
  });
  const meta = await prepareNpmMetaPackage({ root, version });
  const metaTarball = await packNpmMetaPackage(meta);
  if (path.basename(platformTarball) !== npmTarballFileName({ version, target })) {
    throw new Error("npm package smoke resolved an unexpected platform tarball");
  }
  if (path.basename(metaTarball) !== npmMetaTarballFileName(version)) {
    throw new Error("npm package smoke resolved an unexpected meta tarball");
  }

  const directory = await mkdtemp(path.join(workDirectory ?? os.tmpdir(), "codexhost-npm-smoke-"));
  try {
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: "codexhost-npm-smoke", private: true }, null, 2)}\n`,
      "utf8",
    );
    execFileSync("npm", ["install", "--ignore-scripts", platformTarball, metaTarball], {
      cwd: directory,
      stdio: "inherit",
    });
    const packageName = NPM_PLATFORM_PACKAGE_NAMES[target.id];
    const packageRoot = path.join(directory, "node_modules", ...packageName.split("/"));
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const architecture = target.packageArchitecture ?? target.installerArchitecture;
    if (JSON.stringify(manifest.os) !== JSON.stringify([target.hostPlatform])) {
      throw new Error(`installed package os is invalid: ${JSON.stringify(manifest.os)}`);
    }
    if (JSON.stringify(manifest.cpu) !== JSON.stringify([architecture])) {
      throw new Error(`installed package cpu is invalid: ${JSON.stringify(manifest.cpu)}`);
    }
    if (process.platform !== "win32") {
      for (const relative of executablePaths) {
        const mode = (await stat(path.join(packageRoot, relative))).mode & 0o777;
        if ((mode & 0o111) === 0) throw new Error(`${relative} is not executable`);
      }
    }
    const command = path.join(
      directory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codexhost.cmd" : "codexhost",
    );
    const output = execFileSync(command, ["--version"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    if (output !== version) throw new Error(`installed codexhost reported '${output}'`);
    return { platformTarball, metaTarball, packageName };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const result = await smokeNpmPackage({
    targetName: requireArgument(arguments_, "--target"),
    version: requireArgument(arguments_, "--version"),
  });
  console.log(`package=${result.packageName}`);
  console.log(`platform_tarball=${result.platformTarball}`);
  console.log(`meta_tarball=${result.metaTarball}`);
}
