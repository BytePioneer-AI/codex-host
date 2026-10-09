/**
 * Browser asset composition for the DSH-derived Web UI.
 *
 * The DSH Host composes the client plugin graph at runtime from its Loader tree. This module
 * replaces that with an explicit plugin list: it reads each package's `dsh.client` manifest,
 * orders the rows by their module graph, renders the boot injections into the Vite shell's
 * index.html, and answers the `/plugins/??a,b&rev=x` combo route the module system expects.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const CLIENT_MODULES_ID = "@deepseek-ai/dsh-client-modules";
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/;

interface ClientManifest {
  inject?: string[];
  external?: string[];
  immediately?: boolean;
}

interface PluginRecord {
  id: string;
  dir: string;
  clientPath: string;
  manifest: ClientManifest;
  rev: string;
}

interface BootEntry {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
  immediately?: true;
  external?: string[];
}

interface BootBatch {
  phase: "bootstrap" | "application";
  url: string;
  rev: string;
  entries: string[];
}

export interface BootGraph {
  rev: string;
  entries: BootEntry[];
  batches: BootBatch[];
}

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
  /** Packed distribution root (`web/` with `index.html`, assets, `plugins.json`, `plugins/`). */
  packedRoot?: string;
  /** Ordered client plugin package names to compose. */
  plugins: readonly string[];
  /** Global configuration objects injected before the shell runs. */
  globals: Readonly<Record<string, unknown>>;
  /** Document title. */
  title: string;
}

export interface AssetResponse {
  body: Buffer;
  contentType: string;
}

function shortHash(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
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

function stripClientSuffix(name: string): string {
  return name.endsWith("/client") ? name.slice(0, -"/client".length) : name;
}

function orderByModuleGraph(records: readonly PluginRecord[]): PluginRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const ordered: PluginRecord[] = [];
  const placed = new Set<string>();
  const open: string[] = [];
  const visit = (record: PluginRecord): void => {
    if (placed.has(record.id)) return;
    if (open.includes(record.id)) throw new Error(`web-assets: module graph cycle at ${record.id}`);
    open.push(record.id);
    for (const name of record.manifest.external ?? []) {
      const dependency = byId.get(name) ?? byId.get(stripClientSuffix(name));
      if (dependency !== undefined && dependency !== record) visit(dependency);
    }
    open.pop();
    placed.add(record.id);
    ordered.push(record);
  };
  for (const record of records) visit(record);
  return ordered;
}

function prepareSource(bundle: string): string {
  let source = bundle.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");
  if (!source.endsWith("\n")) source += "\n";
  return source;
}

function scriptTag(text: string): string {
  return `<script>${text.replace(/<\/script/giu, "<\\/script")}</script>`;
}

function globalScript(name: string, value: unknown): string {
  return scriptTag(
    `globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value).replace(/</gu, "\\u003c")}`,
  );
}

const MODULE_QUEUE = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id==="${CLIENT_MODULES_ID}")
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`;

const THEME_SCRIPT = `(() => {
  const preference = "system"
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', "14px")
})()`;

/** Composed plugin graph plus the responses that serve it. */
export class WebAssets {
  readonly distRoot: string;
  readonly graph: BootGraph;
  private readonly records: PluginRecord[];
  private readonly byId: Map<string, PluginRecord>;
  private readonly combos = new Map<string, AssetResponse>();
  private readonly indexHtml: Buffer;

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
          const stat = statSync(clientPath);
          return {
            id: plugin.id,
            dir,
            clientPath,
            manifest: plugin.manifest,
            rev: shortHash(`${stat.mtimeMs}:${stat.size}:${plugin.id}`),
          };
        });
      this.records = orderByModuleGraph(records);
      this.byId = new Map(this.records.map((record) => [record.id, record]));
      this.graph = this.composeGraph();
      this.indexHtml = this.renderIndex();
      return;
    }
    if (options.repoRoot === undefined)
      throw new Error("web-assets: repoRoot or packedRoot is required");
    this.distRoot = resolve(options.repoRoot, "apps/web/dist");
    const packages = scanWorkspacePackages(options.repoRoot);
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
      const clientPath = join(dir, rel);
      const stat = statSync(clientPath);
      records.push({
        id,
        dir,
        clientPath,
        manifest,
        rev: shortHash(`${stat.mtimeMs}:${stat.size}:${id}`),
      });
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
    this.records = orderByModuleGraph(records);
    this.byId = new Map(this.records.map((record) => [record.id, record]));
    this.graph = this.composeGraph();
    this.indexHtml = this.renderIndex();
  }

  private composeGraph(): BootGraph {
    const entries: BootEntry[] = this.records.map((record) => ({
      id: record.id,
      url: `plugins/??${record.id}/client.js&rev=${record.rev}`,
      rev: record.rev,
      ...(record.manifest.inject !== undefined ? { inject: record.manifest.inject } : {}),
      ...(record.manifest.immediately === true ? { immediately: true as const } : {}),
      ...((record.manifest.external?.length ?? 0) > 0
        ? { external: record.manifest.external }
        : {}),
    }));
    const bootstrap = this.records.filter((record) => record.id === CLIENT_MODULES_ID);
    const application = this.records.filter((record) => record.id !== CLIENT_MODULES_ID);
    const batches: BootBatch[] = [];
    for (const [phase, group] of [
      ["bootstrap", bootstrap],
      ["application", application],
    ] as const) {
      if (group.length === 0) continue;
      const ids = group.map((record) => record.id);
      const body = Buffer.from(
        group.map((record) => prepareSource(readFileSync(record.clientPath, "utf8"))).join(""),
      );
      const rev = shortHash(body);
      const url = `plugins/??${ids.map((id) => `${id}/client.js`).join(",")}&rev=${rev}`;
      this.combos.set(this.comboKey(ids), { body, contentType: "text/javascript; charset=utf-8" });
      batches.push({ phase, url, rev, entries: ids });
    }
    return { rev: shortHash(JSON.stringify({ entries, batches })), entries, batches };
  }

  private comboKey(ids: readonly string[]): string {
    return ids.join(",");
  }

  private renderIndex(): Buffer {
    const template = readFileSync(join(this.distRoot, "index.html"), "utf8");
    const head: string[] = [
      '<base href="./">',
      "<style>:root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}</style>",
    ];
    for (const [name, value] of Object.entries(this.options.globals))
      head.push(globalScript(name, value));
    head.push(scriptTag(MODULE_QUEUE));
    for (const batch of this.graph.batches.filter((item) => item.phase === "application")) {
      head.push(`<link rel="preload" as="script" href="${batch.url.replace(/&/gu, "&amp;")}">`);
    }
    for (const batch of this.graph.batches.filter((item) => item.phase === "bootstrap")) {
      head.push(`<script src="${batch.url.replace(/&/gu, "&amp;")}"></script>`);
    }
    head.push(globalScript("__DSH_BOOT__", this.graph));
    const body =
      scriptTag(THEME_SCRIPT) +
      scriptTag("(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()");
    const html = template
      .replace("<head>", `<head>\n${head.join("\n")}`)
      .replace(/<title>[^<]*<\/title>/u, `<title>${this.options.title}</title>`)
      .replace("<body>", `<body>${body}`);
    return Buffer.from(html);
  }

  index(): AssetResponse {
    return { body: this.indexHtml, contentType: "text/html; charset=utf-8" };
  }

  /**
   * Answer one `/plugins/...` request.
   * @param pathAndSearch - the request path including its search string.
   */
  plugin(pathAndSearch: string): AssetResponse | undefined {
    const url = new URL(pathAndSearch, "http://local");
    const search = decodeURIComponent(url.search);
    if (url.pathname === "/plugins/" && search.startsWith("??")) {
      const resourceEnd = search.indexOf("&rev=");
      const resources = (resourceEnd < 0 ? search.slice(2) : search.slice(2, resourceEnd)).split(
        ",",
      );
      if (resources.some((resource) => resource.endsWith(".map"))) {
        return {
          body: Buffer.from('{"version":3,"sources":[],"mappings":""}'),
          contentType: "application/json",
        };
      }
      const ids = resources.map((resource) => resource.replace(/\/client\.js$/u, ""));
      const cached = this.combos.get(this.comboKey(ids));
      if (cached !== undefined) return cached;
      const records = ids.map((id) => this.byId.get(id));
      if (records.some((record) => record === undefined)) return undefined;
      const body = Buffer.from(
        records
          .map((record) => prepareSource(readFileSync((record as PluginRecord).clientPath, "utf8")))
          .join(""),
      );
      const response = { body, contentType: "text/javascript; charset=utf-8" };
      this.combos.set(this.comboKey(ids), response);
      return response;
    }
    // Package-local chunk: /plugins/<id>/<client.x.js>
    const rest = url.pathname.slice("/plugins/".length);
    const slash = rest.lastIndexOf("/");
    if (slash < 0) return undefined;
    const id = decodeURIComponent(rest.slice(0, slash));
    const fileName = rest.slice(slash + 1);
    const record = this.byId.get(id);
    if (record === undefined) return undefined;
    if (fileName.endsWith(".map")) {
      return {
        body: Buffer.from('{"version":3,"sources":[],"mappings":""}'),
        contentType: "application/json",
      };
    }
    if (!CLIENT_CHUNK.test(fileName)) return undefined;
    const chunkPath = join(dirname(record.clientPath), fileName);
    if (!existsSync(chunkPath)) return undefined;
    return {
      body: Buffer.from(prepareSource(readFileSync(chunkPath, "utf8"))),
      contentType: "text/javascript; charset=utf-8",
    };
  }

  /**
   * Write a self-contained copy of the composed plugins for a packed distribution.
   * @param outDir - the distribution's `web/` directory.
   */
  exportPlugins(outDir: string): PackedPlugin[] {
    const rows: PackedPlugin[] = [];
    for (const record of this.records) {
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

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : path.slice(dot)] ?? "application/octet-stream";
}
