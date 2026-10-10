/**
 * Pack a self-contained CodexHost Web distribution:
 *
 *   dist/codexhost-web/
 *     server.mjs              bundled server (ws, web-push, qrcode-terminal inlined)
 *     preview.mjs             isolated localhost launcher (excludes Codex/Pi)
 *     host-runtime.mjs        the same independent Host implementation
 *     native/codexhost[.exe]   current-platform service lifecycle Launcher
 *     web/                    Vite shell + composed client plugins + plugins.json
 *     adapters/codex/         bundled Codex Harness adapter
 *     adapters/<id>/          optional prebuilt Harness plugins
 *     package.json, README.md
 *
 * Requires TypeScript/plugins, native Launcher and Web UI builds in the same checkout.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
const codexRoot = join(repoRoot, "packages/adapters/codex");
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
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: `#!/usr/bin/env node\n${banner}` },
  external: ["bufferutil", "utf-8-validate"],
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
    join(out, "host-runtime.mjs"),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

// 3. Codex adapter as a self-contained plugin (entry `plugin.mjs`).
const codexOut = join(out, "adapters/codex");
await build({
  entryPoints: [join(codexRoot, "src/plugin.ts")],
  outfile: join(codexOut, "plugin.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: banner },
  logLevel: "warning",
});
cpSync(join(codexRoot, "assets"), join(codexOut, "assets"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(codexRoot, "manifest.json"), "utf8")) as Record<
  string,
  unknown
>;
writeFileSync(
  join(codexOut, "manifest.json"),
  `${JSON.stringify({ ...manifest, entry: "./plugin.mjs" }, null, 2)}\n`,
);

// 4. Already bundled plugins retain their assets and runtime files when moved to another machine.
for (const plugin of servicePlugins) {
  cpSync(plugin.directory, join(out, "adapters", plugin.id), {
    recursive: true,
    dereference: true,
  });
}

// The Host's plugin loader requires explicit opt-in; Codex remains the native
// Desktop route rather than an external service plugin.
writeFileSync(
  join(out, "adapters/enabled.json"),
  JSON.stringify({ version: 1, enabled: servicePlugins.map((plugin) => plugin.id) }) + "\n",
);

// 5. Package metadata and retained source licenses.
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));
mkdirSync(join(out, "licenses"), { recursive: true });
cpSync(join(frontendRoot, "LICENSE"), join(out, "licenses/DSH-MIT.txt"));
cpSync(
  resolve(dirname(fileURLToPath(import.meta.resolve("image-size"))), "../LICENSE"),
  join(out, "licenses/image-size-MIT.txt"),
);
cpSync(join(frontendRoot, "THIRD_PARTY_NOTICES.md"), join(out, "licenses/THIRD_PARTY_NOTICES.md"));
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "codexhost-web",
      version,
      description: "Run Claude Code, Codex, Pi and other coding agents from any browser or phone.",
      type: "module",
      bin: { "codexhost-web": "./server.mjs" },
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

    node server.mjs [--host 0.0.0.0] [--port 3180] [--adapters <dir>[,<dir>...]]

Default shared mode starts or connects to one independent local CH service. Desktop need not be open;
closing either UI leaves the service and its tasks running. Both use the same CH data directory.
This bundle contains the current-platform native Launcher and the same Host runtime, not Node or Harness CLIs.
Use --ch-data <dir> to select Host data separately from Web's --data, and --ch-codex-home for native metadata.
A running old Desktop-owned Host is never taken over; arrange its update/restart separately.
Explicit --ch-cdp selects the legacy Desktop path. Pin writes still require Desktop's native service.
Recovery reconnects and reloads history; it does not resend uncertain commands.

For an authenticated localhost preview, use \`node preview.mjs\` (requires bundled Claude Code).
This launcher removes inherited CODEXHOST_* variables, NODE_OPTIONS and NODE_PATH from the server environment.
It defaults to Claude Code, listens on 127.0.0.1, keeps authentication enabled,
and uses ~/.codexhost-web-preview and ~/codexhost-web-preview-workspace.
Use \`--harness all\` for every bundled session plugin except Codex/Pi, or \`--harness <id,...>\` for a subset.
Selection requires installed/authenticated native CLIs and does not imply full Web capability verification.
Optional preview flags: --port, --data, --workspace, --harness, --ch-data, --ch-codex-home.
Ctrl+C stops Web only. Explicit backend maintenance: native/codexhost host stop --node <absolute-node> --host-runtime <absolute-host-runtime.mjs> --data <absolute-ch-data>.
Close clients first to prevent their on-demand restart; stopping the backend also stops its tasks.
Do not launch server.mjs directly from a CodexHost-managed session with inherited Desktop settings.
Codex and Pi are intentionally excluded from preview; their CLI routing still needs separate verification.

Included Harness plugins: ${["codex", ...extraAdapters.map((plugin) => plugin.id)].join(", ")}.
Standalone loads these from \`adapters/\`; shared mode loads them only in the canonical Host.
Codex Desktop and CodexHost.app are not required for Web external Threads.
Default plugin input is the build of this checkout, not an installed CodexHost.app.
The packed server uses only its bundled plugins unless --adapters is supplied.
Install and authenticate each Harness CLI separately on the server machine.
\`--adapters\` overrides the plugin directories (comma-separated); it does not install Harness CLIs.

Web data lives in \`~/.codexhost-web\` (settings, access token, push keys and explicit standalone sessions).
Shared canonical metadata remains in the Host's \`~/.codexhost\` and history remains native to each Harness.
The default listener is localhost. For phones, use an HTTPS reverse proxy such as Tailscale Serve;
PWA installation and Web Push need HTTPS. Do not expose \`--no-auth\` to a network.

This distribution includes LGPL-licensed CodexHost code and MIT-licensed DSH-derived UI.
Retained license texts and dependency notices are in LICENSE and licenses/.
`,
);
console.log(
  `packed ${String(plugins.length)} client plugins and ${String(extraAdapters.length + 1)} Harness plugins into ${out}`,
);
