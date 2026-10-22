/**
 * Pack a self-contained CodexHost Web distribution:
 *
 *   dist/codexhost-web/
 *     app/server.mjs          bundled server (ws, web-push, qrcode-terminal inlined)
 *     preview.mjs             environment-isolated launcher
 *     app/host-runtime.mjs    the same independent Host implementation
 *     native/codexhost[.exe]   current-platform service lifecycle Launcher
 *     web/                    Vite shell + composed client plugins + plugins.json
 *     adapters/<id>/          prebuilt Harness plugins, including Codex CLI
 *     package.json, README.md
 *
 * Requires TypeScript/plugins, native Launcher and Web UI builds in the same checkout.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build } from "esbuild";

import { readPackagedAdapters } from "../src/packaged-adapters.ts";
import { CLIENT_GLOBALS, CLIENT_PLUGINS } from "../src/plugins.ts";
import { WebAssets } from "../src/web-assets.ts";

const serverRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverRoot, "../..");
const frontendRoot = join(repoRoot, "apps/web-ui");
const { values, positionals } = parseArgs({
  options: {
    adapters: { type: "string", default: join(repoRoot, "packages/host-runtime/dist/plugins") },
    harness: { type: "string" },
    launcher: {
      type: "string",
      default: join(
        repoRoot,
        "target/debug",
        process.platform === "win32" ? "codexhost.exe" : "codexhost",
      ),
    },
  },
  allowPositionals: true,
});
if (positionals.length > 1 || (values.harness !== undefined && values.adapters === undefined)) {
  throw new Error(
    "Usage: pack.ts [output] [--adapters <prebuilt-plugins-dir> [--harness <id,...>]]",
  );
}
const extraAdapters =
  values.adapters === undefined
    ? []
    : readPackagedAdapters(
        resolve(values.adapters),
        values.harness === undefined ? undefined : new Set(values.harness.split(",")),
      );
const servicePlugins = [
  ...extraAdapters,
  ...readPackagedAdapters(resolve(values.adapters as string), undefined, {
    includeUsage: true,
  }).filter((plugin) => plugin.kind === "usage"),
];
const out = resolve(positionals[0] ?? join(serverRoot, "dist/codexhost-web"));
const version = (
  JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as { version: string }
).version;
const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};
if (
  contains(out, repoRoot) ||
  servicePlugins.some(
    (plugin) => contains(out, plugin.directory) || contains(plugin.directory, out),
  )
) {
  throw new Error("Pack output must not overwrite the repository or overlap input plugins");
}

const launcher = resolve(values.launcher as string);
if (!existsSync(launcher))
  throw new Error(
    "Build the native Launcher before packing Web (npm run build:rust), or supply --launcher.",
  );
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "web"), { recursive: true });

// 1. Vite shell and composed client plugins.
cpSync(join(frontendRoot, "apps/web/dist"), join(out, "web"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map") && !/[\\/]preview(\.html)?$/u.test(source),
});
const assets = new WebAssets({
  repoRoot: frontendRoot,
  plugins: CLIENT_PLUGINS,
  globals: CLIENT_GLOBALS,
  title: "CodexHost",
});
const plugins = assets.exportPlugins(join(out, "web"));

// 2. Server bundle. CommonJS dependencies (ws, web-push) need a real `require`.
const banner =
  "import { createRequire as __codexhostCreateRequire } from 'node:module'; const require = __codexhostCreateRequire(import.meta.url);";
await build({
  entryPoints: [join(serverRoot, "src/main.ts")],
  outfile: join(out, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: `#!/usr/bin/env node\n${banner}` },
  // The Office engine is a platform-native package with worker files and a
  // prebuilt executable; it stays a real install beside the server bundle.
  external: ["bufferutil", "utf-8-validate", "@deepseek-ai/libreoffice-kit"],
  logLevel: "warning",
});

/**
 * Copy one installed package and its installed dependency closure.
 * @param name - package name to copy.
 * @param copied - names already copied.
 */
function copyRuntimePackage(name: string, copied: Set<string>): void {
  if (copied.has(name)) return;
  const source = join(repoRoot, "node_modules", name);
  if (!existsSync(source)) return;
  copied.add(name);
  cpSync(source, join(out, "node_modules", name), { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dependency of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
    copyRuntimePackage(dependency, copied);
}
// The Office conversion provider resolves the engine package and its worker
// files at runtime, so the current platform's engine must ship beside app/.
copyRuntimePackage("@deepseek-ai/libreoffice-kit", new Set());
copyRuntimePackage("node-pty", new Set());

// The terminal provider spawns its private runner as a separate process; the
// source-mode entry cannot run under plain Node, so ship a bundled entry.
await build({
  entryPoints: [join(frontendRoot, "packages/subprocess/subprocess-local/src/bin.ts")],
  outfile: join(out, "app/subprocess-runner.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-pty"],
  logLevel: "warning",
});

await build({
  entryPoints: [join(serverRoot, "scripts/preview.ts")],
  outfile: join(out, "preview.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});

// The same Host implementation and native lifecycle entry support Web-first startup.
mkdirSync(join(out, "native"), { recursive: true });
cpSync(launcher, join(out, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost"));
execFileSync(
  process.execPath,
  [
    join(repoRoot, "packages/host-runtime/scripts/build-release.mjs"),
    "--output",
    join(out, "app/host-runtime.mjs"),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

// 3. Already bundled plugins retain their assets and runtime files when moved to another machine.
for (const plugin of servicePlugins) {
  cpSync(plugin.directory, join(out, "adapters", plugin.id), {
    recursive: true,
    dereference: true,
  });
}

// The Host's plugin loader requires explicit opt-in; the enabled list is data,
// never a Host registration.
writeFileSync(
  join(out, "adapters/enabled.json"),
  JSON.stringify({ version: 1, enabled: servicePlugins.map((plugin) => plugin.id) }) + "\n",
);

// 4. Package metadata and retained source licenses.
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));
mkdirSync(join(out, "licenses"), { recursive: true });
cpSync(join(frontendRoot, "LICENSE"), join(out, "licenses/DSH-MIT.txt"));
cpSync(
  resolve(dirname(fileURLToPath(import.meta.resolve("image-size"))), "../LICENSE"),
  join(out, "licenses/image-size-MIT.txt"),
);
cpSync(join(frontendRoot, "THIRD_PARTY_NOTICES.md"), join(out, "licenses/THIRD_PARTY_NOTICES.md"));
for (const [name, file] of [
  ["@deepseek-ai/libreoffice-kit", "LICENSE"],
  ["@deepseek-ai/libreoffice-kit", "NOTICE"],
] as const) {
  const source = join(repoRoot, "node_modules", name, file);
  if (existsSync(source)) cpSync(source, join(out, `licenses/libreoffice-kit-${file}`));
}
for (const name of readdirSync(join(repoRoot, "node_modules/@deepseek-ai"))) {
  if (!name.startsWith("libreoffice-kit-")) continue;
  const directory = join(repoRoot, "node_modules/@deepseek-ai", name);
  for (const file of readdirSync(join(directory, "licenses"))) {
    cpSync(join(directory, "licenses", file), join(out, "licenses", `${name}-${file}`));
  }
}
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "codexhost-web",
      version,
      description:
        "Run Claude Code, Codex CLI, Pi and other coding agents from any browser or phone.",
      type: "module",
      bin: { "codexhost-web": "./app/server.mjs" },
      engines: { node: ">=22.19" },
      os: [process.platform],
      cpu: [process.arch],
      license: "LGPL-3.0-only",
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, "README.md"),
  `# CodexHost Web ${version}

    node app/server.mjs [--host 0.0.0.0] [--port 4400] [--adapters <dir>[,<dir>...]]

Default shared mode starts or connects to one independent local CH service. Desktop need not be open;
closing either UI leaves the service and its tasks running. Both use the same CH data directory.
This bundle contains the current-platform native Launcher and the same Host runtime, not Node or Harness CLIs.
Server and Host runtime bundles live in app/, matching the Launcher's standard installed-resource layout.
Use --ch-data <dir> to select Host data separately from Web's --data, and --ch-codex-home for native metadata.
A running old Desktop-owned Host is never taken over; arrange its update/restart separately.
Explicit --ch-cdp selects the legacy Desktop path. Pin writes still require Desktop's native service.
Recovery reconnects and reloads history; it does not resend uncertain commands.

For an authenticated localhost preview, use \`node preview.mjs\`.
This launcher removes inherited CODEXHOST_* variables, CODEX_CLI_PATH, NODE_OPTIONS and NODE_PATH from the server environment.
It defaults to every bundled session Harness (including Codex and Pi), listens on 127.0.0.1, keeps authentication enabled,
and uses ~/.codexhost/web and ~/codexhost-web-preview-workspace.
Without --data, a custom --ch-data <root> also selects <root>/web.
Old profiles, lock files and migration markers are not inspected or moved. There is no standalone migration or rollback entry.
No Harness selection is needed; \`--harness <id,...>\` remains an optional advanced subset override.
Missing CLIs and connection failures are normal unavailable states, not Web startup failures.
Using a Harness requires an installed/authenticated native CLI; default enablement does not imply full Web capability verification.
Optional preview flags: --port, --data, --workspace, --harness, --ch-data, --ch-codex-home.
Native ensure, stop and restart serialize lifecycle operations per Host data directory.
Restart keeps the lock through shutdown and readiness; reconnecting clients reuse the replacement.
No profile/home ownership lock or exit proof is used. The existing Mapping Store lock remains.
Packed Web retains its Host, native Launcher and complete plugins in <ch-data>/host-builds/<content-hash>/;
repackaging does not replace these files. Host cwd is the Host data directory. External path overrides
remain caller-managed. Snapshots are not automatically deleted; stop their clients and Host before cleanup.
Ctrl+C stops Web only. Explicit backend maintenance: native/codexhost host stop --node <absolute-node> --host-runtime <absolute-host-runtime.mjs> --data <absolute-ch-data>.
Use host restart with the same arguments for replacement while updated clients stay open.
Close older clients without lifecycle locking first. Stopping or restarting the backend stops its tasks.
Do not launch app/server.mjs directly from a CodexHost-managed session with inherited Desktop settings.
Codex CLI is an ordinary preinstalled external Harness. Its executable comes from the shared discovery rules
and the persisted launch setting for \`codex-cli\`; \`CODEX_HOME\` selects the native home, otherwise ~/.codex.
The native CLI uses local credentials directly; there is no authentication preflight or special queue pause.
Codex Desktop and CodexHost.app are not required for Web external Threads. Do not open the same native Session
in GUI Codex and Web Codex CLI at the same time.
GUI native Codex requests keep their official route and never load this plugin.

Included Harness plugins: ${extraAdapters.map((plugin) => plugin.id).join(", ")}.
Every external plugin, including Codex CLI, loads in the canonical Host in shared mode.
Default plugin input is the build of this checkout, not an installed CodexHost.app.
The packed server uses only its bundled plugins unless --adapters is supplied.
Install and authenticate each Harness CLI separately on the server machine.
\`--adapters\` overrides the plugin directories (comma-separated); it does not install Harness CLIs.

Web data lives in \`~/.codexhost/web\` (settings, access token, push keys and uploaded attachments).
Shared canonical metadata remains in the Host's \`~/.codexhost\` and history remains native to each Harness.
The default listener is localhost. For phones, use an HTTPS reverse proxy such as Tailscale Serve;
PWA installation and Web Push need HTTPS. Do not expose \`--no-auth\` to a network.

This distribution includes LGPL-licensed CodexHost code and MIT-licensed DSH-derived UI.
Retained license texts and dependency notices are in LICENSE and licenses/.
`,
);
console.log(
  `packed ${String(plugins.length)} client plugins and ${String(extraAdapters.length)} Harness plugins into ${out}`,
);
