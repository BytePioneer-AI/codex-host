/** Web resources shared by the installer and npm platform packages. */
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { CLIENT_GLOBALS, CLIENT_PLUGINS } from "./plugins.ts";
import { WebAssets } from "./web-assets.ts";
import { packWebRuntime, WEB_RUNTIME_PACKAGES } from "./pack-web-runtime.ts";
import { packKoffiBinding } from "./pack-koffi.ts";

interface LockedPackage {
  version: string;
  resolved: string;
  integrity: string;
  optionalDependencies?: Record<string, string>;
}

/** Preserve the official, locked engine artifacts without shipping or downloading an engine. */
export function officeEngineArtifacts(lock: { packages: Record<string, LockedPackage> }) {
  const entry = lock.packages["node_modules/@deepseek-ai/libreoffice-kit"];
  if (!entry?.optionalDependencies) throw new Error("Missing locked Office engine packages");
  return Object.entries(entry.optionalDependencies).map(([name, version]) => {
    const artifact = lock.packages[`node_modules/${name}`];
    if (
      !artifact ||
      artifact.version !== version ||
      !artifact.resolved.startsWith("https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-") ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(artifact.integrity)
    ) {
      throw new Error(`Invalid locked Office engine artifact: ${name}`);
    }
    return { name, version, url: artifact.resolved, integrity: artifact.integrity };
  });
}

export async function packReleaseWeb(options: {
  root: string;
  app: string;
  browserBuild: string;
  platform: string;
  architecture: string;
}): Promise<void> {
  const { root, app, browserBuild, platform, architecture } = options;
  const frontend = join(root, "apps/web-ui");
  const modules = join(app, "web-modules");
  const dependencies = join(modules, "node_modules");
  const web = join(app, "web");
  mkdirSync(modules, { recursive: true });
  cpSync(join(browserBuild, "apps/web/dist"), web, {
    recursive: true,
    filter: (source) => !source.endsWith(".map") && !/[\\/]preview(\.html)?$/u.test(source),
  });
  new WebAssets({
    repoRoot: frontend,
    buildRoot: browserBuild,
    plugins: CLIENT_PLUGINS,
    globals: CLIENT_GLOBALS,
    title: "CodexHost",
  }).exportPlugins(web);

  // Keep Node's ordinary ESM and caller-relative require resolution inside web-modules.
  writeFileSync(join(app, "web-server.mjs"), 'import "./web-modules/server.mjs";\n');
  const banner =
    'import { createRequire as __codexhostCreateRequire } from "node:module"; const require = __codexhostCreateRequire(import.meta.url);';
  await build({
    entryPoints: [join(root, "packages/web-server/src/main.ts")],
    outfile: join(modules, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: { CODEXHOST_RELEASE_WEB: "true" },
    minifySyntax: true,
    banner: { js: banner },
    external: [
      "bufferutil",
      "utf-8-validate",
      "@deepseek-ai/libreoffice-kit",
      "playwright-core",
      ...WEB_RUNTIME_PACKAGES,
    ],
    logLevel: "warning",
  });
  await packWebRuntime(modules);
  await build({
    entryPoints: [join(frontend, "packages/subprocess/subprocess-local/src/bin.ts")],
    outfile: join(modules, "subprocess-runner.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node-pty"],
    logLevel: "warning",
  });

  const pty = join(root, "node_modules/node-pty");
  for (const file of ["package.json", "LICENSE", "lib", `prebuilds/${platform}-${architecture}`]) {
    cpSync(join(pty, file), join(dependencies, "node-pty", file), {
      recursive: true,
      filter: (source) => !/\.(?:map|pdb)$/u.test(source) && !source.endsWith(".test.js"),
    });
  }
  for (const name of ["playwright-core", "@xterm/headless", "@xterm/addon-serialize", "koffi"]) {
    cpSync(join(root, "node_modules", name), join(dependencies, name), {
      recursive: true,
      dereference: true,
      filter: (source) => !/\.(?:map|pdb)$/u.test(source),
    });
  }

  await packKoffiBinding({ root, dependencies, platform, architecture });

  const kit = "@deepseek-ai/libreoffice-kit";
  const kitSource = join(root, "node_modules", kit);
  const kitOutput = join(dependencies, kit);
  for (const file of ["package.json", "LICENSE", "NOTICE"]) {
    mkdirSync(kitOutput, { recursive: true });
    cpSync(join(kitSource, file), join(kitOutput, file));
  }
  // Bundle the entry and workers' JS dependencies, retaining their runtime-relative filenames.
  await build({
    entryPoints: readdirSync(join(kitSource, "lib"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => join(kitSource, "lib", file)),
    outdir: join(kitOutput, "lib"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: banner },
    external: ["koffi", "@deepseek-ai/libreoffice-kit-*"],
    logLevel: "warning",
  });
  const engines = officeEngineArtifacts(
    JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
  );
  writeFileSync(join(modules, "office-engines.json"), JSON.stringify(engines, null, 2) + "\n");

  const licenses = join(modules, "licenses");
  mkdirSync(licenses, { recursive: true });
  for (const [source, name] of [
    ["LICENSE", "CodexHost-LGPL.txt"],
    ["apps/web-ui/LICENSE", "DSH-MIT.txt"],
    ["apps/web-ui/THIRD_PARTY_NOTICES.md", "DSH-THIRD_PARTY_NOTICES.md"],
    ["node_modules/image-size/LICENSE", "image-size-MIT.txt"],
    ["node_modules/js-yaml/LICENSE", "js-yaml-MIT.txt"],
    ["node_modules/import-meta-resolve/license", "import-meta-resolve-MIT.txt"],
  ] as const)
    cpSync(resolve(root, source), join(licenses, name));
}
