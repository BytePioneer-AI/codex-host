import { posix } from "node:path";
import { Script } from "node:vm";
import { readHostExtensionAsset } from "@codexhost/harness-plugin-files";
import {
  DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES,
  hostExtensionCanonicalPath,
  hostExtensionResourcePathSchema,
  type HostExtensionManifest,
} from "@codexhost/shared-contracts";
// Use the pure-JS browser distribution lazily; zero-extension hosts avoid parser initialization.
import type { RollupError } from "@rollup/browser";

interface ModulePackage {
  id: string;
  activationId: string;
  digest: string;
  manifest: HostExtensionManifest;
}

const VIRTUAL = "\0codexhost:";
const MAX_MODULES = 256;

function resolveModule(importer: string, specifier: string): string {
  if (!/^\.\.?\//u.test(specifier) || /[?#\\]/u.test(specifier))
    throw new Error(`Only package-relative .mjs imports are supported: ${specifier}`);
  // Resolve URL-escaped path segments without ever normalizing an escape back into the package.
  const parts = posix
    .dirname(importer)
    .split("/")
    .filter((part) => part !== ".");
  for (const encoded of specifier.split("/")) {
    const part = decodeURIComponent(encoded);
    if (/[\\/]/u.test(part)) throw new Error(`Invalid module path: ${specifier}`);
    if (part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined)
        throw new Error(`Module import escapes the package: ${specifier}`);
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** Link without running any extension code in Node or resolving against the Node filesystem. */
export async function linkRendererExtensionModule(
  dataDir: string,
  { id, activationId, digest, manifest }: ModulePackage,
  entry: string,
): Promise<string> {
  if (entry !== manifest.page?.entry && entry !== manifest.widget?.entry)
    throw new Error(`Not a declared page or widget entry: ${entry}`);
  const base = `codexhost-extension://${id}/${activationId}/${digest}/`;
  const backend = manifest.backend && hostExtensionCanonicalPath(manifest.backend.entry);
  let bytes = 0;
  let count = 0;
  const { rollup } = await import("@rollup/browser");
  const bundle = await rollup({
    input: VIRTUAL + entry,
    // Retain side effects even if the module exports nothing.
    treeshake: false,
    plugins: [
      {
        name: "host-extension-assets",
        resolveId(source, importer) {
          try {
            const path = importer ? resolveModule(importer.slice(VIRTUAL.length), source) : entry;
            if (!path.endsWith(".mjs")) throw new Error(`Expected a .mjs module: ${source}`);
            hostExtensionResourcePathSchema.parse(path);
            if (hostExtensionCanonicalPath(path) === backend)
              throw new Error(`Cannot import backend.entry: ${path}`);
            return VIRTUAL + path;
          } catch (error) {
            throw new Error(
              `${importer?.slice(VIRTUAL.length) ?? entry}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        resolveDynamicImport(_source, importer) {
          throw new Error(
            `${importer.slice(VIRTUAL.length)}: dynamic import() is not supported on Desktop`,
          );
        },
        async load(moduleId) {
          const path = moduleId.slice(VIRTUAL.length);
          if (++count > MAX_MODULES) throw new Error(`Module graph exceeds ${MAX_MODULES} files`);
          const asset = await readHostExtensionAsset({ dataDir, id, activationId, digest, path });
          const buffer = Buffer.from(asset.base64, "base64");
          bytes += buffer.length;
          if (bytes > DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES)
            throw new Error("Desktop extension module graph size limit exceeded");
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^#![^\n]*/u, "");
        },
        resolveImportMeta(property, { moduleId }) {
          const url =
            base + moduleId.slice(VIRTUAL.length).split("/").map(encodeURIComponent).join("/");
          if (property === "url") return JSON.stringify(url);
          if (property === null) return `({__proto__: null, url: ${JSON.stringify(url)}})`;
          return "void 0";
        },
      },
    ],
    onwarn(warning, warn) {
      if (warning.code === "MISSING_EXPORT" || warning.code === "NAMESPACE_CONFLICT")
        throw new Error(warning.message);
      // Circular static imports are linked by Rollup, not treated as a failure.
      if (warning.code !== "CIRCULAR_DEPENDENCY") warn(warning);
    },
  }).catch((error: RollupError) => {
    const path = error.id?.startsWith(VIRTUAL) ? error.id.slice(VIRTUAL.length) : entry;
    const loc = error.loc ? `:${error.loc.line}:${error.loc.column + 1}` : "";
    throw new Error(`${path}${loc}: ${error.message}`, { cause: error });
  });
  try {
    const { output } = await bundle.generate({ format: "system", compact: true });
    if (output.length !== 1 || output[0].imports.length || output[0].dynamicImports.length)
      throw new Error("Expected a self-contained Desktop extension module graph");
    // System output supports top-level await. There are no runtime dependencies;
    // capture the declaration locally, with no global loader or string evaluation.
    const factory = `(async function () {
      "use strict";
      const values = {__proto__: null};
      let execute;
      const System = {register(_deps, declare) {
        execute = declare((key, value) => {
          if (typeof key === "string") values[key] = value;
          else Object.assign(values, key);
          return value;
        }).execute;
      }};
      ${output[0].code}
      await execute();
      const namespace = {__proto__: null};
      for (const name of Object.keys(values))
        Object.defineProperty(namespace, name, { enumerable: true, get: () => values[name] });
      return { namespace: Object.freeze(namespace) };
    })`;
    new Script(factory, { filename: base + entry });
    return factory;
  } finally {
    await bundle.close();
  }
}
