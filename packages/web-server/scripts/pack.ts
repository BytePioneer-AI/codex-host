/**
 * Pack a self-contained CodexHost Web distribution:
 *
 *   dist/codexhost-web/
 *     server.mjs              bundled server (ws, web-push, qrcode-terminal inlined)
 *     preview.mjs             isolated localhost launcher (excludes Codex/Pi)
 *     web/                    Vite shell + composed client plugins + plugins.json
 *     adapters/codex/         bundled Codex Harness adapter
 *     adapters/<id>/          optional prebuilt Harness plugins
 *     package.json, README.md
 *
 * Requires `npm run build:typescript` and the Web UI build in the same checkout.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  extraAdapters.some((plugin) => contains(out, plugin.directory) || contains(plugin.directory, out))
) {
  throw new Error("Pack output must not overwrite the repository or overlap input plugins");
}

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
for (const plugin of extraAdapters) {
  cpSync(plugin.directory, join(out, "adapters", plugin.id), {
    recursive: true,
    dereference: true,
  });
}

// 5. Package metadata and retained source licenses.
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));
mkdirSync(join(out, "licenses"), { recursive: true });
cpSync(join(frontendRoot, "LICENSE"), join(out, "licenses/DSH-MIT.txt"));
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

To preview alongside CodexHost Desktop, use \`node preview.mjs\` (requires bundled Claude Code).
This launcher removes inherited CODEXHOST_* variables, NODE_OPTIONS and NODE_PATH from the server environment.
It defaults to Claude Code, listens on 127.0.0.1, keeps authentication enabled,
and uses ~/.codexhost-web-preview and ~/codexhost-web-preview-workspace.
Use \`--harness all\` for every bundled session plugin except Codex/Pi, or \`--harness <id,...>\` for a subset.
Selection requires installed/authenticated native CLIs and does not imply full Web capability verification.
Optional preview flags: --port, --data, --workspace, --harness. Stop with Ctrl+C.
Do not launch server.mjs directly from a CodexHost-managed session with inherited Desktop settings.
Codex and Pi are intentionally excluded from preview; their CLI routing still needs separate verification.

Included Harness plugins: ${["codex", ...extraAdapters.map((plugin) => plugin.id)].join(", ")}.
The server loads these from \`adapters/\`; Codex Desktop and CodexHost.app are not required.
Default plugin input is the build of this checkout, not an installed CodexHost.app.
The packed server uses only its bundled plugins unless --adapters is supplied.
Install and authenticate each Harness CLI separately on the server machine.
\`--adapters\` overrides the plugin directories (comma-separated); it does not install Harness CLIs.

Data lives in \`~/.codexhost-web\` (sessions, settings, access token, push keys).
The default listener is localhost. For phones, use an HTTPS reverse proxy such as Tailscale Serve;
PWA installation and Web Push need HTTPS. Do not expose \`--no-auth\` to a network.

This distribution includes LGPL-licensed CodexHost code and MIT-licensed DSH-derived UI.
Retained license texts and dependency notices are in LICENSE and licenses/.
`,
);
console.log(
  `packed ${String(plugins.length)} client plugins and ${String(extraAdapters.length + 1)} Harness plugins into ${out}`,
);
