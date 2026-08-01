import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ensureNodeArchive, extractNodeRuntime, sha256File } from "./node-runtime.mjs";
import { parseReleaseArguments, releaseUsage } from "./targets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runtimeLicenses = [
  { packageName: "diff", license: "BSD-3-Clause", output: "diff-LICENSE.txt" },
  { packageName: "zod", license: "MIT", output: "zod-LICENSE.txt" },
];

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function releaseBuildCommands(target, platform = process.platform) {
  return [
    { label: "TypeScript build", command: npmCommand(platform), args: ["run", "build:typescript"] },
    { label: "Renderer build", command: npmCommand(platform), args: ["run", "build:renderer"] },
    {
      label: "Rust release build",
      command: "cargo",
      args: [
        "build",
        "--release",
        "--locked",
        "--target",
        target.rustTarget,
        "--package",
        "codexhost-launcher",
        "--package",
        "codexhost-shim",
      ],
    },
  ];
}

async function runCommand({ label, command, args }, cwd = repositoryRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return metadata;
}

async function copyReleaseFile(source, destination, label, executable = false) {
  await requireRegularFile(source, label);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (executable && process.platform !== "win32") await chmod(destination, 0o755);
}

async function productVersion(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("root package.json must define a release version");
  }
  return manifest.version;
}

export function numericPackageVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) throw new Error(`release version '${version}' must start with major.minor.patch`);
  const numbers = match.slice(1).map(Number);
  if (numbers[0] > 255 || numbers[1] > 255 || numbers[2] > 65_535) {
    throw new Error(`release version '${version}' exceeds installer version limits`);
  }
  return numbers.join(".");
}

function packageManifest(value, packageName) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.license !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error(`runtime package '${packageName}' has invalid license metadata`);
  }
  return value;
}

async function writeThirdPartyNotices(root, payloadRoot) {
  const licensesDirectory = path.join(payloadRoot, "licenses");
  await mkdir(licensesDirectory, { recursive: true });
  const notices = [
    "codexhost third-party notices",
    "",
    "Node.js 24.13.1",
    "License: see licenses/Node.js-LICENSE.txt",
    "",
  ];
  for (const dependency of runtimeLicenses) {
    const dependencyRoot = path.join(root, "node_modules", dependency.packageName);
    const manifest = packageManifest(
      JSON.parse(await readFile(path.join(dependencyRoot, "package.json"), "utf8")),
      dependency.packageName,
    );
    if (manifest.license !== dependency.license) {
      throw new Error(
        `unexpected license metadata for runtime package '${dependency.packageName}'`,
      );
    }
    await copyReleaseFile(
      path.join(dependencyRoot, "LICENSE"),
      path.join(licensesDirectory, dependency.output),
      `${dependency.packageName} license`,
    );
    notices.push(
      `${dependency.packageName} ${manifest.version}`,
      `License: ${dependency.license}`,
      `License text: licenses/${dependency.output}`,
      "",
    );
  }
  await writeFile(
    path.join(payloadRoot, "THIRD_PARTY_NOTICES.txt"),
    `${notices.join("\n").trimEnd()}\n`,
    "utf8",
  );
}

export function expectedPayloadPaths(target) {
  return [
    `bin/codexhost${target.executableSuffix}`,
    `libexec/codexhost-shim${target.executableSuffix}`,
    `runtime/node${target.executableSuffix}`,
    "app/host-runtime.mjs",
    "app/renderer-extension.js",
    "licenses/Node.js-LICENSE.txt",
    "licenses/diff-LICENSE.txt",
    "licenses/zod-LICENSE.txt",
    "THIRD_PARTY_NOTICES.txt",
  ].sort();
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(`release Payload contains a symbolic link: ${relative}`);
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push({ absolute, relative });
    else throw new Error(`release Payload contains a non-file: ${relative}`);
  }
  return files;
}

export async function validatePayload({ payloadRoot, target, root }) {
  const expected = expectedPayloadPaths(target);
  const files = await walkFiles(payloadRoot);
  const actual = files.map((file) => file.relative).sort();
  const missing = expected.filter((relative) => !actual.includes(relative));
  const extra = actual.filter((relative) => !expected.includes(relative));
  if (missing.length > 0)
    throw new Error(`release Payload is missing files: ${missing.join(", ")}`);
  if (extra.length > 0) {
    throw new Error(`release Payload contains non-allowlist files: ${extra.join(", ")}`);
  }

  const forbiddenReferences = [
    root,
    "@anthropic-ai/",
    "@codexhost/adapter-claude-code",
    "claude-agent-sdk",
  ];
  for (const file of files.filter((entry) => /\.(?:js|mjs|txt)$/u.test(entry.relative))) {
    const text = await readFile(file.absolute, "utf8");
    if (forbiddenReferences.some((reference) => text.includes(reference))) {
      throw new Error(`release Payload file contains a forbidden reference: ${file.relative}`);
    }
  }
  return actual;
}

export async function prepareReleasePayload({ target, root = repositoryRoot }) {
  if (target.hostPlatform !== process.platform) {
    throw new Error(
      `release target '${target.id}' requires host platform '${target.hostPlatform}', current host is '${process.platform}'`,
    );
  }
  for (const command of releaseBuildCommands(target)) await runCommand(command, root);

  const version = await productVersion(root);
  const installerVersion = numericPackageVersion(version);
  const outputRoot = path.join(root, "build", "release", version, target.id);
  const payloadRoot = path.join(outputRoot, "payload");
  await rm(payloadRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });

  const rustOutput = path.join(root, "target", target.rustTarget, "release");
  await copyReleaseFile(
    path.join(rustOutput, `codexhost${target.executableSuffix}`),
    path.join(payloadRoot, "bin", `codexhost${target.executableSuffix}`),
    "release Launcher",
    true,
  );
  await copyReleaseFile(
    path.join(rustOutput, `codexhost-shim${target.executableSuffix}`),
    path.join(payloadRoot, "libexec", `codexhost-shim${target.executableSuffix}`),
    "release Shim",
    true,
  );

  await runCommand(
    {
      label: "Pi-only Host Bundle build",
      command: process.execPath,
      args: [
        "packages/host-runtime/scripts/build-release.mjs",
        "--output",
        path.join(payloadRoot, "app", "host-runtime.mjs"),
      ],
    },
    root,
  );
  await copyReleaseFile(
    path.join(root, "packages", "renderer-extension", "dist", "index.js"),
    path.join(payloadRoot, "app", "renderer-extension.js"),
    "Renderer Bundle",
  );

  const archivePath = await ensureNodeArchive({
    target,
    cacheDirectory: path.join(root, ".codexhost", "release-cache", "node"),
  });
  await extractNodeRuntime({ target, archivePath, payloadRoot });
  await writeThirdPartyNotices(root, payloadRoot);
  await validatePayload({ payloadRoot, target, root });
  return { version, installerVersion, outputRoot, payloadRoot };
}

async function requireNonEmptyArtifact(artifactPath) {
  const metadata = await requireRegularFile(artifactPath, "release artifact");
  if (metadata.size === 0) throw new Error(`release artifact is empty: ${artifactPath}`);
}

export async function packageReleaseTarget({ target, root = repositoryRoot }) {
  const prepared = await prepareReleasePayload({ target, root });
  const extension = target.hostPlatform === "darwin" ? ".dmg" : ".msi";
  const artifactBase = path.join(prepared.outputRoot, `codexhost-${prepared.version}-${target.id}`);
  const artifactPath = `${artifactBase}${extension}`;
  const checksumPath = `${artifactPath}.sha256`;
  const priorExtensions =
    target.hostPlatform === "darwin"
      ? [".app.zip", ".app.zip.sha256", ".dmg", ".dmg.sha256"]
      : [".msi", ".msi.sha256"];
  await Promise.all(
    priorExtensions.map((suffix) => rm(`${artifactBase}${suffix}`, { force: true })),
  );

  if (target.hostPlatform === "darwin") {
    await runCommand(
      {
        label: "macOS DMG packaging",
        command: "bash",
        args: [
          path.join(root, "scripts", "release", "macos", "package.sh"),
          prepared.payloadRoot,
          path.join(prepared.outputRoot, "codexhost.app"),
          artifactPath,
          prepared.installerVersion,
        ],
      },
      root,
    );
  } else {
    await runCommand(
      {
        label: "Windows MSI packaging",
        command: "pwsh",
        args: [
          "-NoProfile",
          "-File",
          path.join(root, "scripts", "release", "windows", "package.ps1"),
          "-PayloadRoot",
          prepared.payloadRoot,
          "-OutputPath",
          artifactPath,
          "-Version",
          prepared.installerVersion,
          "-Architecture",
          target.installerArchitecture,
        ],
      },
      root,
    );
  }

  await requireNonEmptyArtifact(artifactPath);
  const checksum = await sha256File(artifactPath);
  await writeFile(checksumPath, `${checksum}  ${path.basename(artifactPath)}\n`, "utf8");
  return { ...prepared, artifactPath, checksumPath, checksum };
}

export async function runReleaseCli(arguments_) {
  const parsed = parseReleaseArguments(arguments_);
  if (parsed.help) {
    console.log(releaseUsage());
    return;
  }
  const result = await packageReleaseTarget({ target: parsed.target });
  console.log(`payload=${result.payloadRoot}`);
  console.log(`artifact=${result.artifactPath}`);
  console.log(`sha256=${result.checksum}`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
