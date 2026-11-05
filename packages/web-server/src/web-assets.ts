/**
 * Browser asset composition for the DSH-derived Web UI.
 *
 * The DSH Host composes the client plugin graph at runtime from its Loader tree. This module
 * composes the built-in list and selected external packages: it reads each `dsh.client` manifest,
 * orders the rows by their module graph, renders the boot injections into the Vite shell's
 * index.html, and answers the `/plugins/??a,b&rev=x` combo route the module system expects.
 */

import {
  createClientAssets,
  renderClientBoot,
  type ClientAssets,
  type ClientSource,
  type ClientGraph,
} from "@codexhost/dsh-web-backend/client-assets";
import { readWebPluginBundle } from "@codexhost/dsh-web-backend/plugin-bundles";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkExternalClientDependencies,
  readExternalClientAssets,
  EXTERNAL_CLIENT_PLATFORM_MODULES,
  type ClientAssetManifest as ClientManifest,
  type ExternalClientPluginSource,
} from "./external-client-assets.ts";
import {
  checkClientRuntimeVersions,
  clientRuntimeRequirements,
  CLIENT_RUNTIME_VERSIONS_FILE,
  packedClientRuntimeVersions,
  sourceClientRuntimeVersions,
  type ClientRuntimeVersions,
} from "./client-runtime-versions.ts";

const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

interface PluginRecord {
  id: string;
  dir: string;
  clientPath: string;
  manifest: ClientManifest;
  external?: true;
}

export type BootGraph = ClientGraph;

/** One plugin row of a packed distribution (`web/plugins.json`). */
export interface PackedPlugin {
  id: string;
  /** Directory under `web/plugins/` holding `client.js` and its package-local chunks. */
  dir: string;
  manifest: ClientManifest;
}

export interface WebAssetOptions {
  /** DSH repository root used to locate workspace packages and the built Vite shell. */
  repoRoot?: string;
  /** Build output root when browser bundles are emitted outside the source checkout. */
  buildRoot?: string;
  /** Packed distribution root (`web/` with `index.html`, assets, `plugins.json`, `plugins/`). */
  packedRoot?: string;
  /** Ordered client plugin package names to compose. */
  plugins: readonly string[];
  /** Installed package metadata; construction never executes plugin code. */
  externalPlugins?: readonly ExternalClientPluginSource[];
  /** Native registry from the activated Host tree; absent for validation and recovery. */
  clients?: ClientAssets;
  /** Global configuration objects injected before the shell runs. */
  globals: Readonly<Record<string, unknown>>;
  /** Document title. */
  title: string;
}

export interface AssetResponse {
  body: Buffer;
  contentType: string;
}

/** Map every workspace package name to its directory. */
function scanWorkspacePackages(repoRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (typeof pkg.name === "string" && !result.has(pkg.name)) result.set(pkg.name, dir);
      } catch {
        // Ignore malformed fixtures.
      }
    }
    if (depth === 0) return;
    for (const name of readdirSync(dir)) {
      if (
        name === "node_modules" ||
        name.startsWith(".") ||
        name === "lib" ||
        name === "src" ||
        name === "tests"
      )
        continue;
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) visit(child, depth - 1);
      } catch {
        // Broken links are not packages.
      }
    }
  };
  visit(join(repoRoot, "packages"), 2);
  visit(join(repoRoot, "apps"), 1);
  visit(join(repoRoot, "vendor"), 1);
  return result;
}

function clientExportOf(exportsField: unknown): string | undefined {
  if (typeof exportsField !== "object" || exportsField === null) return undefined;
  const client = (exportsField as Record<string, unknown>)["./client"];
  if (typeof client === "string") return client;
  if (typeof client === "object" && client !== null) {
    const fallback = (client as Record<string, unknown>).default;
    if (typeof fallback === "string") return fallback;
  }
  return undefined;
}

function scriptTag(text: string): string {
  return `<script>${text.replace(/<\/script/giu, "<\\/script")}</script>`;
}

function globalScript(name: string, value: unknown): string {
  return scriptTag(
    `globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value).replace(/</gu, "\\u003c")}`,
  );
}

const THEME_SCRIPT = `(() => {
  let preference = "system"
  let fontSize = 14
  try {
    const saved = JSON.parse(localStorage.getItem('codexhost.web.preferences.v1:ui-theme') || 'null')
    if (['light', 'dark', 'system'].includes(saved?.user?.preference)) preference = saved.user.preference
    if (Number.isInteger(saved?.user?.fontSize) && saved.user.fontSize >= 10 && saved.user.fontSize <= 22) fontSize = saved.user.fontSize
  } catch {}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', fontSize + 'px')
})()`;

/** Composed plugin graph plus the responses that serve it. */
export class WebAssets {
  readonly distRoot: string;
  private clients: ClientAssets;
  private readonly records: PluginRecord[];
  private readonly byId: Map<string, PluginRecord>;
  private indexHtml: Buffer;
  private readonly runtimeVersions: ClientRuntimeVersions | undefined;

  constructor(private readonly options: WebAssetOptions) {
    if (options.packedRoot !== undefined) {
      this.distRoot = resolve(options.packedRoot);
      const packed = JSON.parse(
        readFileSync(join(this.distRoot, "plugins.json"), "utf8"),
      ) as PackedPlugin[];
      const wanted = new Set(options.plugins);
      const records = packed
        .filter((plugin) => wanted.size === 0 || wanted.has(plugin.id))
        .map((plugin) => {
          const dir = join(this.distRoot, "plugins", plugin.dir);
          const clientPath = join(dir, "client.js");
          return {
            id: plugin.id,
            dir,
            clientPath,
            manifest: plugin.manifest,
          };
        });
      this.runtimeVersions = packedClientRuntimeVersions(this.distRoot);
      this.records = this.composeRecords(records);
      this.byId = new Map(this.records.map((record) => [record.id, record]));
      this.clients = options.clients ?? createClientAssets(this.clientSources());
      this.indexHtml = this.renderIndex();
      return;
    }
    if (options.repoRoot === undefined)
      throw new Error("web-assets: repoRoot or packedRoot is required");
    this.distRoot = resolve(options.buildRoot ?? options.repoRoot, "apps/web/dist");
    const packages = scanWorkspacePackages(options.repoRoot);
    this.runtimeVersions = sourceClientRuntimeVersions(
      options.repoRoot,
      packages,
      options.plugins,
      EXTERNAL_CLIENT_PLATFORM_MODULES,
    );
    const records: PluginRecord[] = [];
    for (const id of options.plugins) {
      const dir = packages.get(id);
      if (dir === undefined) throw new Error(`web-assets: unknown client package ${id}`);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        exports?: unknown;
        dsh?: { client?: ClientManifest & { platform?: string } };
      };
      const manifest = pkg.dsh?.client;
      if (manifest === undefined || manifest.platform !== "web")
        throw new Error(`web-assets: ${id} declares no web client`);
      const rel = clientExportOf(pkg.exports);
      if (rel === undefined) throw new Error(`web-assets: ${id} exports no ./client bundle`);
      const clientPath = join(
        options.buildRoot ? resolve(options.buildRoot, relative(options.repoRoot, dir)) : dir,
        rel,
      );
      records.push({ id, dir, clientPath, manifest });
    }
    const present = new Set(records.map((record) => record.id));
    const missing: string[] = [];
    const isClientPlugin = (name: string): boolean => {
      const dir = packages.get(name);
      if (dir === undefined) return false;
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        dsh?: { client?: { platform?: string } };
      };
      return pkg.dsh?.client?.platform === "web";
    };
    for (const record of records) {
      for (const dependency of record.manifest.inject ?? []) {
        // Shell-provided platform modules (for example ui-primitives) are not graph rows.
        if (!present.has(dependency) && isClientPlugin(dependency))
          missing.push(`${record.id} -> ${dependency}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `web-assets: plugins inject packages outside the composed set:\n  ${missing.join("\n  ")}`,
      );
    }
    this.records = this.composeRecords(records);
    this.byId = new Map(this.records.map((record) => [record.id, record]));
    this.clients = options.clients ?? createClientAssets(this.clientSources());
    this.indexHtml = this.renderIndex();
  }

  /** Browser-only builtins seed the native registry without executing their unrelated Host halves. */
  clientSources(): ClientSource[] {
    return this.records.map((record) => ({
      id: record.id,
      clientPath: record.clientPath,
      manifest: record.manifest,
    }));
  }

  private composeRecords(builtins: PluginRecord[]): PluginRecord[] {
    const selectedIds = new Set(builtins.map((record) => record.id));
    for (const plugin of this.options.externalPlugins ?? []) {
      if (selectedIds.has(plugin.id))
        throw new Error(`web-assets: duplicate browser plugin ${plugin.id}`);
      if (EXTERNAL_CLIENT_PLATFORM_MODULES.has(plugin.id))
        throw new Error(`web-assets: external plugin cannot replace platform module ${plugin.id}`);
      selectedIds.add(plugin.id);
      const manifest = JSON.parse(readFileSync(join(plugin.directory, "package.json"), "utf8"));
      checkClientRuntimeVersions(
        plugin.id,
        clientRuntimeRequirements(manifest),
        this.runtimeVersions,
      );
    }
    const ids = new Set<string>();
    const selected = (this.options.externalPlugins ?? []).flatMap(
      (plugin) => readWebPluginBundle(plugin).clients,
    );
    for (const { id } of [...builtins, ...selected]) {
      if (ids.has(id)) throw new Error(`web-assets: duplicate browser plugin ${id}`);
      ids.add(id);
    }
    const external = selected.map(readExternalClientAssets);
    checkExternalClientDependencies(external, ids);
    for (const plugin of external)
      checkClientRuntimeVersions(plugin.id, plugin.requirements, this.runtimeVersions);
    return [
      ...builtins,
      ...external.map((plugin) => ({
        id: plugin.id,
        dir: plugin.directory,
        clientPath: plugin.clientPath,
        manifest: plugin.manifest,
        external: true as const,
      })),
    ];
  }

  /** Boot graph rendered into the document as `__DSH_BOOT__`. */
  get graph(): BootGraph {
    return this.clients.graph();
  }

  /** Composed client bundles, for development rebuild polling. */
  bundles(): { id: string; path: string }[] {
    return this.records
      .filter((record) => record.external === undefined)
      .map((record) => ({ id: record.id, path: record.clientPath }));
  }

  /** The Vite shell document the served index is rendered from. */
  get shellIndexPath(): string {
    return join(this.distRoot, "index.html");
  }

  /**
   * Re-read one rebuilt client bundle and recompose the graph and document around it.
   * @param id - composed plugin package name.
   * @returns the new revision, or undefined when the plugin is unknown or its bytes are unchanged.
   */
  rebuilt(id: string): string | undefined {
    const record = this.byId.get(id);
    if (record === undefined || record.external !== undefined) return undefined;
    const previous = this.graph.entries.find((entry) => entry.id === id)?.rev;
    const rev = this.clients.rebuilt(id);
    if (rev === previous) return undefined;
    this.indexHtml = this.renderIndex();
    return rev;
  }

  /**
   * Re-render the document after the Vite shell rebuilt.
   * @returns whether the served document changed.
   */
  shellRebuilt(): boolean {
    const previous = this.indexHtml;
    this.indexHtml = this.renderIndex();
    return !previous.equals(this.indexHtml);
  }

  private renderIndex(): Buffer {
    const template = renderClientBoot(
      readFileSync(join(this.distRoot, "index.html"), "utf8"),
      this.graph,
    );
    const head: string[] = [
      '<base href="./">',
      "<style>:root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}</style>",
    ];
    for (const [name, value] of Object.entries(this.options.globals))
      head.push(globalScript(name, value));
    const body = scriptTag(THEME_SCRIPT);
    const html = template
      .replace("<head>", `<head>\n${head.join("\n")}`)
      .replace(/<title>[^<]*<\/title>/u, `<title>${this.options.title}</title>`)
      .replace("<body>", `<body>${body}`);
    return Buffer.from(html);
  }

  index(): AssetResponse {
    // The native registry can change independently of development file rebuilds.
    this.indexHtml = this.renderIndex();
    return { body: this.indexHtml, contentType: "text/html; charset=utf-8" };
  }

  /**
   * Answer one `/plugins/...` request.
   * @param pathAndSearch - the request path including its search string.
   */
  plugin(pathAndSearch: string): AssetResponse | undefined {
    const url = new URL(pathAndSearch, "http://local");
    const revisions = url.searchParams.getAll("rev");
    if (revisions.length > 1) return undefined;
    const base = `${url.pathname}${url.search}`.split("&rev=")[0] ?? "";
    const advertised = [...this.graph.entries, ...this.graph.batches].find(
      (row) => `/${row.url}`.split("&rev=")[0] === base,
    );
    const onlyBuiltins =
      advertised !== undefined &&
      ("entries" in advertised ? advertised.entries : [advertised.id]).every(
        (id) => this.byId.get(id)?.external === undefined && this.byId.has(id),
      );
    // Keep unversioned requests and development's built-in fallback. Versioned
    // external resources always retain the native registry's exact-revision check.
    if (advertised !== undefined && (revisions.length === 0 || onlyBuiltins)) {
      url.search = new URL(advertised.url, "http://local/").search;
    } else if (revisions.length === 0) {
      const entry = this.graph.entries.find((row) =>
        url.pathname.startsWith(`/plugins/${row.id}/`),
      );
      if (entry !== undefined) url.searchParams.set("rev", entry.rev);
    }
    return this.clients.readBundle(url.href);
  }

  /**
   * Copy built-in plugins for a distribution. Installed packages stay in the Web plugin profile.
   * @param outDir - the distribution's `web/` directory.
   */
  exportPlugins(outDir: string): PackedPlugin[] {
    const rows: PackedPlugin[] = [];
    for (const record of this.records) {
      if (record.external !== undefined) continue;
      const dir = record.id.replace(/^@/u, "").replace(/\//gu, "__");
      const target = join(outDir, "plugins", dir);
      mkdirSync(target, { recursive: true });
      const sourceDir = dirname(record.clientPath);
      for (const name of readdirSync(sourceDir)) {
        if (name === "client.js" || CLIENT_CHUNK.test(name))
          copyFileSync(join(sourceDir, name), join(target, name));
      }
      rows.push({ id: record.id, dir, manifest: record.manifest });
    }
    writeFileSync(join(outDir, "plugins.json"), `${JSON.stringify(rows, null, 2)}\n`);
    if (this.runtimeVersions !== undefined)
      writeFileSync(
        join(outDir, CLIENT_RUNTIME_VERSIONS_FILE),
        `${JSON.stringify(this.runtimeVersions, null, 2)}\n`,
      );
    return rows;
  }

  /** Static file from the Vite shell output. */
  dist(pathname: string): AssetResponse | undefined {
    const target = resolve(this.distRoot, `.${decodeURIComponent(pathname)}`);
    if (!target.startsWith(this.distRoot) || !existsSync(target) || !statSync(target).isFile())
      return undefined;
    return { body: readFileSync(target), contentType: contentTypeOf(target) };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

/** Resolve the MIME type shared by Web assets and Harness brand resources.
 * @param path Asset file path.
 * @returns Known content type, or an opaque binary fallback.
 */
export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : path.slice(dot)] ?? "application/octet-stream";
}
