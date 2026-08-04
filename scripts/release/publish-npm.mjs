import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { NPM_PACKAGE_NAME, npmPlatformPackageName, npmTarballFileName } from "./prepare-npm.mjs";
import { npmMetaTarballFileName } from "./prepare-npm-meta.mjs";
import { supportedReleaseTargets, releaseTarget } from "./targets.mjs";

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseNpmPublishArguments(arguments_) {
  let artifactsRoot;
  let version;
  let tag = "latest";
  let registry;
  let dryRun = false;
  let provenance = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const readValue = (option) => {
      const value = arguments_[++index];
      if (!value) throw new Error(`${option} requires a value`);
      return value;
    };
    if (argument === "--artifacts") artifactsRoot = readValue(argument);
    else if (argument.startsWith("--artifacts=")) artifactsRoot = argument.slice(12);
    else if (argument === "--version") version = readValue(argument);
    else if (argument.startsWith("--version=")) version = argument.slice(10);
    else if (argument === "--tag") tag = readValue(argument);
    else if (argument.startsWith("--tag=")) tag = argument.slice(6);
    else if (argument === "--registry") registry = readValue(argument);
    else if (argument.startsWith("--registry=")) registry = argument.slice(11);
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--provenance") provenance = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown npm publish option: ${argument}`);
  }
  if (!artifactsRoot) throw new Error("--artifacts is required");
  if (!version || !semverPattern.test(version)) throw new Error("--version must be valid semver");
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(tag)) throw new Error("--tag is invalid");
  return { artifactsRoot, dryRun, provenance, registry, tag, version };
}

async function findTarballs(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) paths.push(...(await findTarballs(root, absolute)));
    else if (entry.isFile() && entry.name.endsWith(".tgz")) paths.push(absolute);
  }
  return paths;
}

export async function createNpmPublishPlan({ artifactsRoot, version }) {
  const tarballs = await findTarballs(artifactsRoot);
  const locate = (fileName) => {
    const matches = tarballs.filter((tarball) => path.basename(tarball) === fileName);
    if (matches.length === 0) throw new Error(`missing npm release tarball: ${fileName}`);
    if (matches.length > 1) throw new Error(`duplicate npm release tarball: ${fileName}`);
    return matches[0];
  };
  const platforms = supportedReleaseTargets().map((targetId) => {
    const target = releaseTarget(targetId);
    return {
      kind: "platform",
      packageName: npmPlatformPackageName(target),
      tarball: locate(npmTarballFileName({ version, target })),
      version,
    };
  });
  return [
    ...platforms,
    {
      kind: "meta",
      packageName: NPM_PACKAGE_NAME,
      tarball: locate(npmMetaTarballFileName(version)),
      version,
    },
  ];
}

export function npmPublishCommand(entry, { dryRun, provenance, registry, tag }) {
  const args = ["publish", entry.tarball, "--access", "public", "--tag", tag];
  if (registry) args.push("--registry", registry);
  if (provenance) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  return { command: "npm", args };
}

export function publishNpmPlan(plan, options) {
  for (const entry of plan) {
    const command = npmPublishCommand(entry, options);
    console.log(
      `${options.dryRun ? "checking" : "publishing"} ${entry.packageName}@${entry.version}`,
    );
    const result = spawnSync(command.command, command.args, {
      encoding: "utf8",
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm publish failed for ${entry.packageName} with status ${result.status}`);
    }
  }
}

export async function runNpmPublishCli(arguments_) {
  const parsed = parseNpmPublishArguments(arguments_);
  if (parsed.help) {
    console.log(
      "usage: npm run release:npm:publish -- --artifacts <dir> --version <semver> [--tag <tag>] [--dry-run] [--provenance] [--registry <url>]",
    );
    return;
  }
  const plan = await createNpmPublishPlan(parsed);
  publishNpmPlan(plan, parsed);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmPublishCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost npm publish: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
