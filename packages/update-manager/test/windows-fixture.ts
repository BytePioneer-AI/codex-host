import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function fixtureFile(file: string, contents = "fixture"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

export async function windowsNpmFixture(root: string, nested = false) {
  const prefix = path.join(root, "中文 空格 prefix");
  const cli = path.join(prefix, "node_modules", "@codexhost", "cli");
  const packageRoot = path.join(
    nested ? path.join(cli, "node_modules") : path.join(prefix, "node_modules"),
    "@codexhost",
    "cli-win32-x64",
  );
  const paths = {
    packageRoot,
    npmLauncherPath: path.join(cli, "bin", "codexhost.js"),
    nodePath: path.join(root, "shared-node", "node.exe"),
    npmCliPath: path.join(root, "shared-node", "node_modules", "npm", "bin", "npm-cli.js"),
    launcherExecutable: path.join(packageRoot, "bin", "codexhost.exe"),
  };
  await Promise.all([
    ...[
      paths.npmLauncherPath,
      paths.nodePath,
      paths.npmCliPath,
      paths.launcherExecutable,
      path.join(packageRoot, "app", "host-runtime.mjs"),
      path.join(packageRoot, "libexec", "codexhost-updater.exe"),
    ].map((file) => fixtureFile(file)),
    fixtureFile(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "@codexhost/cli",
        version: "1.2.2",
        bin: { codexhost: "bin/codexhost.js" },
        optionalDependencies: { "@codexhost/cli-win32-x64": "1.2.2" },
      }),
    ),
    fixtureFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@codexhost/cli-win32-x64",
        version: "1.2.2",
        os: ["win32"],
        cpu: ["x64"],
      }),
    ),
    fixtureFile(
      path.join(packageRoot, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.2",
        distribution: "npm",
        target: "windows-x64",
      }),
    ),
    fixtureFile(
      path.join(prefix, "codexhost.cmd"),
      '"%dp0%\\node_modules\\@codexhost\\cli\\bin\\codexhost.js" %*',
    ),
    fixtureFile(
      path.resolve(paths.npmCliPath, "../../package.json"),
      JSON.stringify({ name: "npm", version: "11.8.0" }),
    ),
  ]);
  return { prefix, cli, paths };
}

export async function windowsInstallerFixture(root: string) {
  const installRoot = path.join(root, "Programs", "中文 空格 codexhost");
  const launcherExecutable = path.join(installRoot, "bin", "codexhost.exe");
  await Promise.all([
    fixtureFile(launcherExecutable),
    fixtureFile(path.join(installRoot, "runtime", "node.exe")),
    fixtureFile(path.join(installRoot, "libexec", "codexhost-updater.exe")),
    fixtureFile(path.join(installRoot, "app", "host-runtime.mjs")),
    fixtureFile(
      path.join(installRoot, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.2",
        distribution: "installer",
        target: "windows-x64",
      }),
    ),
  ]);
  return { installRoot, launcherExecutable };
}
