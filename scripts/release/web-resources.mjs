// Web's hashed browser chunks and runtime package assets vary with the build.
export function expectedWebPaths(target) {
  const platform = `${target.hostPlatform}-${target.packageArchitecture ?? target.installerArchitecture}`;
  return [
    "app/web-server.mjs",
    "app/web/index.html",
    "app/web/plugins.json",
    "app/web/client-runtime-versions.json",
    "app/web-modules/server.mjs",
    "app/web-modules/subprocess-runner.mjs",
    "app/web-modules/office-engines.json",
    "app/web-modules/node_modules/@deepseek-ai/libreoffice-kit/package.json",
    "app/web-modules/node_modules/koffi/package.json",
    `app/web-modules/node_modules/@koromix/koffi-${platform}/package.json`,
    "app/web-modules/node_modules/playwright-core/package.json",
    "app/web-modules/node_modules/@xterm/headless/package.json",
    "app/web-modules/node_modules/@xterm/addon-serialize/package.json",
    `app/web-modules/node_modules/node-pty/prebuilds/${platform}/${target.hostPlatform === "win32" ? "conpty.node" : "pty.node"}`,
  ];
}

export function isWebResource(relative, target) {
  if (!relative.startsWith("app/web/") && !relative.startsWith("app/web-modules/")) return false;
  if (/(?:^|\/)(?:preview(?:\.html|\.mjs)?|adapters)(?:\/|$)/u.test(relative)) return false;
  if (relative.includes("node_modules/@deepseek-ai/libreoffice-kit-")) return false;
  if (/\.(?:map|pdb)$/u.test(relative)) return false;
  const prebuild = relative.match(/node-pty\/prebuilds\/([^/]+)\//u)?.[1];
  return (
    prebuild === undefined ||
    prebuild ===
      `${target.hostPlatform}-${target.packageArchitecture ?? target.installerArchitecture}`
  );
}

export function webBuildCommand(app, target) {
  return {
    label: "Web release build",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "packages/web-server/scripts/build-release.ts",
      "--output",
      app,
      "--platform",
      target.hostPlatform,
      "--architecture",
      target.packageArchitecture ?? target.installerArchitecture,
    ],
  };
}
