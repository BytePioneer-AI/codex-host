import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createNpmMetaPackageManifest } from "../../../scripts/release/prepare-npm-meta.mjs";
import {
  createNpmPackageManifest,
  createNpmBinLauncherSource,
} from "../../../scripts/release/prepare-npm.mjs";
import { releaseTarget } from "../../../scripts/release/targets.mjs";

const execute = promisify(execFile);
export async function createNpmFixture(root: string) {
  const nodePath = process.execPath;
  const npmCliPath = await realpath(
    process.env.npm_execpath ??
      (process.platform === "win32"
        ? path.join(path.dirname(nodePath), "node_modules/npm/bin/npm-cli.js")
        : path.resolve(path.dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js")),
  );
  const config = path.join(root, "empty.npmrc");
  await writeFile(config, "");
  const globalConfig = path.join(root, "global.npmrc");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    npm_config_userconfig: config,
    npm_config_globalconfig: globalConfig,
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  await writeFile(globalConfig, "");
  const run = async (args: string[], cwd = root, env: NodeJS.ProcessEnv = environment) => {
    const { stdout } = await execute(nodePath, [npmCliPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
  const target = releaseTarget(
    `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"}-${process.arch}`,
  );
  const platformName = `@codexhost/cli-${process.platform}-${process.arch}`;
  const versions = new Map<string, Record<string, unknown>>();
  const archives = new Map<string, Buffer>();
  const requests: string[] = [];
  const state = { denyNetwork: false, delayMs: 0, corruptIntegrity: false, missingPlatform: false };
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").slice(1);
    requests.push(name);
    const respond = () => {
      if (response.destroyed) return;
      if (state.denyNetwork) {
        response.writeHead(503);
        response.end("network disabled");
        return;
      }
      if (name.startsWith("tarballs/")) {
        const bytes = archives.get(name.slice(9));
        if (!bytes) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.end(bytes);
        return;
      }
      if (name === platformName && state.missingPlatform) {
        response.writeHead(404);
        response.end('{"error":"not published"}');
        return;
      }
      const matching = [...versions].filter(([key]) => key.startsWith(`${name}@`));
      if (!matching.length) {
        response.writeHead(404);
        response.end('{"error":"not found"}');
        return;
      }
      const manifests = Object.fromEntries(
        matching.map(([, manifest]) => {
          const value = structuredClone(manifest);
          if (state.corruptIntegrity)
            (value.dist as Record<string, unknown>).integrity =
              `sha512-${Buffer.alloc(64).toString("base64")}`;
          return [String(value.version), value];
        }),
      );
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ name, "dist-tags": { latest: "1.2.4" }, versions: manifests }));
    };
    if (state.delayMs) setTimeout(respond, state.delayMs).unref();
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("registry port missing");
  const registry = `http://127.0.0.1:${address.port}/`;
  Object.assign(environment, { npm_config_registry: registry });
  const pack = async (
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ): Promise<string> => {
    const source = path.join(
      root,
      "sources",
      `${String(manifest.name).replaceAll("/", "-")}-${manifest.version}`,
    );
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "package.json"), JSON.stringify(manifest));
    for (const [relative, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), contents);
    }
    const result = JSON.parse(
      await run(
        [
          "pack",
          "--offline",
          "--ignore-scripts",
          "--update-notifier=false",
          "--json",
          "--cache",
          path.join(root, "pack-cache"),
          "--pack-destination",
          root,
        ],
        source,
      ),
    ) as Array<{ filename: string }>;
    const filename = result[0]?.filename;
    if (!filename) throw new Error("npm pack returned no archive");
    const bytes = await readFile(path.join(root, filename));
    archives.set(filename, bytes);
    versions.set(`${manifest.name}@${manifest.version}`, {
      ...manifest,
      dist: {
        tarball: `${registry}tarballs/${filename}`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
    });
    return path.join(root, filename);
  };
  const publish = async (
    version: string,
    mode: "normal" | "missing-core" | "extra-dependency" = "normal",
  ) => {
    const cliManifest = createNpmMetaPackageManifest({ version });
    if (mode === "extra-dependency")
      Object.assign(cliManifest, { dependencies: { "not-prepared": "1.0.0" } });
    const cli = await pack(cliManifest, {
      "README.md": "fixture",
      "bin/codexhost.js": createNpmBinLauncherSource({ version }),
    });
    const suffix = process.platform === "win32" ? ".exe" : "";
    const files = Object.fromEntries(
      [
        `bin/codexhost${suffix}`,
        `libexec/codexhost-updater${suffix}`,
        `libexec/codexhost-shim${suffix}`,
        ...(process.platform === "win32" ? ["libexec/codexhost-node-repl.exe"] : []),
        "app/host-runtime.mjs",
        "app/desktop-controller.mjs",
        "app/renderer-extension.js",
        "app/console-server.mjs",
        "app/console-web.js",
        "README.md",
      ].map((file) => [file, "fixture"]),
    );
    files["app/codexhost-distribution.json"] = JSON.stringify({
      schemaVersion: 1,
      version,
      distribution: "npm",
      target: target.id,
    });
    if (mode === "missing-core") delete files["app/host-runtime.mjs"];
    const platform = await pack(createNpmPackageManifest({ version, target }), files);
    return { cli, platform };
  };
  const modules = (prefix: string) =>
    path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules");
  const packageVersion = async (prefix: string, name: string) =>
    (
      JSON.parse(await readFile(path.join(modules(prefix), name, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
  const cliVersion = async (prefix: string) => {
    const { stdout } = await execute(
      nodePath,
      [path.join(modules(prefix), "@codexhost/cli/bin/codexhost.js"), "--version"],
      { env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim();
  };
  return {
    root,
    nodePath,
    npmCliPath,
    environment,
    platformName,
    target,
    state,
    requests,
    run,
    pack,
    publish,
    packageVersion,
    cliVersion,
    modules,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
