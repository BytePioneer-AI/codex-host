import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NPM_PACKAGE_DESCRIPTION,
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
    engines: { node: ">=22" },
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

npm automatically installs the matching macOS, Windows, or Linux platform package. Node.js 22 or 24 and the official ChatGPT/Codex Desktop are required.

## Usage

\`\`\`bash
codexhost --version
codexhost
\`\`\`

The \`codexhost\` command starts Codex Desktop. On macOS and Linux it returns immediately while the packaged Launcher keeps supervising in the background. On Windows, the command remains attached until Codex Desktop exits so shells that clean up process trees of completed commands cannot discard the supervisor. Re-running \`codexhost\` attaches to the same controlled instance.

If installation used \`--omit=optional\`, reinstall without that option so npm can select the native package for the current architecture.
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
