import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NPM_PACKAGE_DESCRIPTION,
  NPM_NODE_ENGINE,
  NPM_NODE_REQUIREMENT,
  NPM_PACKAGE_NAME,
  NPM_PLATFORM_PACKAGE_NAMES,
  createNpmBinLauncherSource,
  packNpmPackage,
  resolveNpmPackageVersion,
} from "./prepare-npm.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export function expectedNpmMetaPackagePaths() {
  return ["README.md", "bin/codexhost.js", "package.json"];
}

export function createNpmMetaPackageManifest({ version }) {
  return {
    name: NPM_PACKAGE_NAME,
    version,
    description: NPM_PACKAGE_DESCRIPTION,
    type: "module",
    bin: { codexhost: "bin/codexhost.js" },
    files: ["bin/**", "README.md"],
    engines: { node: NPM_NODE_ENGINE },
    optionalDependencies: Object.fromEntries(
      Object.values(NPM_PLATFORM_PACKAGE_NAMES).map((packageName) => [packageName, version]),
    ),
    keywords: ["codex", "codexhost", "pi", "claude-code", "agent", "harness"],
    repository: {
      type: "git",
      url: "git+https://github.com/BytePioneer-AI/codex-host.git",
    },
    bugs: { url: "https://github.com/BytePioneer-AI/codex-host/issues" },
    homepage: "https://github.com/BytePioneer-AI/codex-host#readme",
    publishConfig: { access: "public" },
  };
}

export function createNpmMetaReadme({ version }) {
  return `# ${NPM_PACKAGE_NAME}

${NPM_PACKAGE_DESCRIPTION}

## Install

\`\`\`bash
npm install -g ${NPM_PACKAGE_NAME}@${version}
\`\`\`

npm automatically installs the matching macOS, Windows, or Linux platform package. ${NPM_NODE_REQUIREMENT} is required. Official ChatGPT/Codex Desktop is only required for the Desktop interface; Web is included and works without it.

## Usage

\`\`\`bash
codexhost --version
codexhost
codexhost web
codexhost status
codexhost autostart on
codexhost autostart status
codexhost stop
codexhost remote install
codexhost remote status
\`\`\`

The \`codexhost\` command starts Codex Desktop and background Web; without Desktop installed it opens Web instead. On macOS and Linux it returns immediately while the packaged Launcher keeps supervising in the background. On Windows, the command remains attached until Codex Desktop exits so shells that clean up process trees of completed commands cannot discard the supervisor. Re-running \`codexhost\` attaches to the same controlled instance.

\`codexhost web\` ensures Host and Web run in the background, prints a local login link and opens a browser. Over SSH or without a graphical session it only prints the link. Closing the terminal, Desktop or browser leaves Host and Web running; the computer must stay awake and connected. \`CODEXHOST_WEB_SERVICE=0\` disables Web startup alongside \`codexhost\`.

Web initially listens on \`127.0.0.1:4400\`. Use the local Connect devices page for LAN access and Tailscale Serve, or run \`codexhost web --host 0.0.0.0 --port 4500\`. The options \`--host\`, \`--port\`, \`--public-url\` and \`--trusted-proxy\` are validated and saved for later starts; an empty value clears an option. Changing them restarts only Web, disconnecting Web terminals but not Host tasks. An occupied port fails without killing its owner or selecting another port. LAN HTTP is unencrypted.

Matching services are reused. A different version or installation replaces the running services; replacing Host interrupts tasks without confirmation. \`codexhost status\` is read-only and shows Host/Web versions, the token-free Web address, the last Web failure and autostart status. \`codexhost stop\` stops managed Desktop, Web, Host, remote services, Broker and Console in that order, reports interrupted Host tasks, and preserves session data and configuration. A Desktop opened independently is not closed. Remote services return when another computer reconnects; interrupted tasks do not resume automatically.

Autostart is off by default. \`codexhost autostart on|off|status\` manages current-user login startup; it starts Host and Web without opening a browser. Linux requires systemd user services; linger is user-managed. Running \`codexhost\` refreshes enabled autostart with the current Node and CLI paths.

Office preview components are downloaded from the npm registry on first use on the Web computer, not the phone. No documents are uploaded for conversion. Download failure affects only Office previews; retry after checking the computer's network.

## Uninstall or downgrade

Before removing this package or switching to a version without background Web support:

\`\`\`bash
codexhost stop
codexhost autostart off
npm uninstall -g ${NPM_PACKAGE_NAME}
\`\`\`

Tailscale Serve configuration remains after stopping or uninstalling. Check \`tailscale serve status\`; only if the HTTPS 443 root path still points to this Web, remove it with \`tailscale serve --https=443 --set-path=/ off\` (substitute the actual HTTPS port). This leaves other paths intact. While Web is running, the local Connect devices page can also disable Serve after confirmation.

## Notes

On macOS, \`remote install\` installs a current-user Aqua Harness broker so Background SSH Hosts can use native Claude Code login without reading, copying, or unlocking Keychain credentials.

If installation used \`--omit=optional\`, reinstall without that option so npm can select the native package for the current architecture.

If startup reports a platform package version mismatch, close Codex Desktop and run the exact reinstall command in the error. This installs both the CLI and its platform package at the same version, replacing stale independently installed payloads. \`codexhost --version\` reports the CLI package version; startup also validates the platform payload before launching it.
`;
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
      throw new Error(`npm meta package contains a symlink: ${relative}`);
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`npm meta package contains a non-file: ${relative}`);
  }
  return files;
}

export async function validateNpmMetaPackage({ packageRoot }) {
  const expected = expectedNpmMetaPackagePaths().sort();
  const actual = (await walkFiles(packageRoot)).sort();
  if (expected.join("\n") !== actual.join("\n")) {
    throw new Error(
      `npm meta package files differ: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== NPM_PACKAGE_NAME)
    throw new Error(`npm meta package name must be ${NPM_PACKAGE_NAME}`);
  if (manifest.bin?.codexhost !== "bin/codexhost.js") {
    throw new Error("npm meta package must expose bin/codexhost.js");
  }
  if (manifest.os !== undefined || manifest.cpu !== undefined) {
    throw new Error("npm meta package must be architecture-neutral");
  }
  return actual;
}

export async function prepareNpmMetaPackage({ version, root = repositoryRoot }) {
  const packageVersion = await resolveNpmPackageVersion(root, version);
  const outputRoot = path.join(root, "build", "npm", packageVersion, "meta");
  const packageRoot = path.join(outputRoot, "package");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "bin", "codexhost.js"),
    createNpmBinLauncherSource({ version: packageVersion }),
    "utf8",
  );
  await chmod(path.join(packageRoot, "bin", "codexhost.js"), 0o755);
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(createNpmMetaPackageManifest({ version: packageVersion }), null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "README.md"),
    createNpmMetaReadme({ version: packageVersion }),
  );
  await validateNpmMetaPackage({ packageRoot });
  return { outputRoot, packageRoot, version: packageVersion };
}

export function npmMetaTarballFileName(version) {
  return `codexhost-cli-${version}.tgz`;
}

export async function packNpmMetaPackage({ outputRoot, packageRoot, version }) {
  const packedPath = await packNpmPackage({ outputRoot, packageRoot });
  const expectedPath = path.join(outputRoot, npmMetaTarballFileName(version));
  if (path.resolve(packedPath) !== path.resolve(expectedPath)) {
    await rm(expectedPath, { force: true });
    await rename(packedPath, expectedPath);
  }
  return expectedPath;
}

export async function runNpmMetaReleaseCli(arguments_) {
  let version;
  let pack = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--pack") pack = true;
    else if (argument === "--version") version = arguments_[++index];
    else if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--help" || argument === "-h") {
      console.log("usage: npm run release:npm:meta -- --version <semver> [--pack]");
      return;
    } else throw new Error(`unknown npm meta release option: ${argument}`);
  }
  const prepared = await prepareNpmMetaPackage({ version });
  console.log(`package=${prepared.packageRoot}`);
  console.log(`version=${prepared.version}`);
  if (pack) {
    console.log(`tarball=${await packNpmMetaPackage(prepared)}`);
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmMetaReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost npm meta release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
