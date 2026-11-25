export const NPM_PACKAGE_NAME = "@codexhost/cli";
export const NPM_PLATFORM_PACKAGE_NAMES = Object.freeze({
  "macos-arm64": "@codexhost/cli-darwin-arm64",
  "macos-x64": "@codexhost/cli-darwin-x64",
  "windows-x64": "@codexhost/cli-win32-x64",
  "windows-arm64": "@codexhost/cli-win32-arm64",
  "linux-x64": "@codexhost/cli-linux-x64",
  "linux-arm64": "@codexhost/cli-linux-arm64",
});

export function npmPlatformPackageName(target) {
  const packageName = NPM_PLATFORM_PACKAGE_NAMES[target.id];
  if (!packageName) throw new Error(`unsupported npm package target: ${target.id}`);
  return packageName;
}

export function npmTarballFileName({ version, target }) {
  return `codexhost-cli-${version}-${target.id}.tgz`;
}

export function npmMetaTarballFileName(version) {
  return `codexhost-cli-${version}.tgz`;
}
