export const NODE_VERSION = "24.13.1";
export const NODE_DIST_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

export const RELEASE_TARGETS = Object.freeze({
  "macos-arm64": Object.freeze({
    id: "macos-arm64",
    hostPlatform: "darwin",
    rustTarget: "aarch64-apple-darwin",
    installerArchitecture: "arm64",
    executableSuffix: "",
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeArchiveSha256: "8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6",
    nodeArchiveFormat: "tar.gz",
    nodeArchiveRoot: `node-v${NODE_VERSION}-darwin-arm64`,
    nodeExecutable: "bin/node",
  }),
  "macos-x64": Object.freeze({
    id: "macos-x64",
    hostPlatform: "darwin",
    rustTarget: "x86_64-apple-darwin",
    installerArchitecture: "x64",
    executableSuffix: "",
    nodeArchive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeArchiveSha256: "527f0578d9812e7dfa225121bda0b1546a6a0e4b5f556295fc8299c272de5fbf",
    nodeArchiveFormat: "tar.gz",
    nodeArchiveRoot: `node-v${NODE_VERSION}-darwin-x64`,
    nodeExecutable: "bin/node",
  }),
  "windows-x64": Object.freeze({
    id: "windows-x64",
    hostPlatform: "win32",
    rustTarget: "x86_64-pc-windows-msvc",
    installerArchitecture: "x64",
    executableSuffix: ".exe",
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeArchiveSha256: "fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279",
    nodeArchiveFormat: "zip",
    nodeArchiveRoot: `node-v${NODE_VERSION}-win-x64`,
    nodeExecutable: "node.exe",
  }),
  "windows-arm64": Object.freeze({
    id: "windows-arm64",
    hostPlatform: "win32",
    rustTarget: "aarch64-pc-windows-msvc",
    installerArchitecture: "arm64",
    executableSuffix: ".exe",
    nodeArchive: `node-v${NODE_VERSION}-win-arm64.zip`,
    nodeArchiveSha256: "0cd29eeb64f3c649db2c4c868779ca277f5a4c49e26c69e5928d01fe0ae06da8",
    nodeArchiveFormat: "zip",
    nodeArchiveRoot: `node-v${NODE_VERSION}-win-arm64`,
    nodeExecutable: "node.exe",
  }),
});

export function supportedReleaseTargets() {
  return Object.keys(RELEASE_TARGETS);
}

export function releaseTarget(name) {
  if (!Object.hasOwn(RELEASE_TARGETS, name)) {
    throw new Error(
      `unknown release target '${name}'; expected one of: ${supportedReleaseTargets().join(", ")}`,
    );
  }
  return RELEASE_TARGETS[name];
}

export function releaseTargetForHost(name, hostPlatform = process.platform) {
  const target = releaseTarget(name);
  if (target.hostPlatform !== hostPlatform) {
    throw new Error(
      `release target '${name}' requires host platform '${target.hostPlatform}', current host is '${hostPlatform}'`,
    );
  }
  return target;
}

export function releaseUsage() {
  return [
    "usage: npm run release:package -- --target <target>",
    `targets: ${supportedReleaseTargets().join(", ")}`,
  ].join("\n");
}

export function parseReleaseArguments(arguments_, hostPlatform = process.platform) {
  let targetName;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--target") {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = arguments_[index + 1];
      if (!targetName) throw new Error("--target requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = argument.slice("--target=".length);
      if (!targetName) throw new Error("--target requires a value");
      continue;
    }
    throw new Error(`unknown release option: ${argument}`);
  }
  if (targetName === undefined) throw new Error("--target is required");
  return { help: false, target: releaseTargetForHost(targetName, hostPlatform) };
}
