/** Read native bundle patches without evaluating plugin code or configuration expressions. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";
import { load } from "js-yaml";
import { applyEntryPatches, entryListSchema, type PatchOptions } from "@codexhost/dsh-web-include";
import type { BundleEntry, WebPluginPackage } from "./plugin-types.ts";

export interface WebPluginBundle extends WebPluginPackage {
  readonly entries: BundleEntry[];
  /** Browser-only packages need a loader row, but must never execute their browser factory in Node. */
  readonly clientOnly: ReadonlySet<string>;
  readonly clients: readonly WebPluginPackage[];
}

interface PackageManifest {
  name?: string;
  main?: string;
  exports?: string | Record<string, unknown>;
  dsh?: { bundle?: { patch?: unknown }; client?: { platform?: string } };
}

function manifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function owningPackage(moduleUrl: string): WebPluginPackage | undefined {
  if (!moduleUrl.startsWith("file:")) return;
  let directory = dirname(fileURLToPath(moduleUrl));
  while (dirname(directory) !== directory) {
    if (existsSync(join(directory, "package.json"))) {
      const pkg = manifest(directory);
      if (typeof pkg.name === "string") return { id: pkg.name, directory };
    }
    directory = dirname(directory);
  }
  return;
}

/** Resolve and compose the package's declared patch layers using Include's native dialect. */
export function readWebPluginBundle(selection: WebPluginPackage): WebPluginBundle {
  const pkg = manifest(selection.directory);
  if (pkg.name !== selection.id)
    throw new Error(`Web extension ${selection.id} has package name ${String(pkg.name)}`);
  const declared = pkg.dsh?.bundle?.patch;
  const patches: PatchOptions[] = [];
  if (declared !== undefined) {
    const files = typeof declared === "string" ? [declared] : declared;
    if (!Array.isArray(files) || !files.every((file) => typeof file === "string"))
      throw new Error(`${selection.id}: dsh.bundle.patch must be a path or a list of paths`);
    for (const file of files) {
      const rows = load(readFileSync(resolvePath(selection.directory, file), "utf8"), {
        schema: entryListSchema,
      });
      if (!Array.isArray(rows)) throw new Error(`${selection.id}: bundle patch must be an array`);
      patches.push(...(rows as PatchOptions[]));
    }
  } else {
    patches.push({ insert: [{ id: selection.id, name: selection.id }] });
  }
  const warnings: string[] = [];
  const entries = applyEntryPatches([], patches, (message, ...args) => {
    let at = 0;
    warnings.push(message.replace(/%C/g, () => JSON.stringify(args[at++])));
  }) as BundleEntry[];
  if (warnings.length) throw new Error(`${selection.id}: ${warnings.join("; ")}`);
  const base = pathToFileURL(join(selection.directory, "package.json")).href;
  const clients = new Map<string, WebPluginPackage>();
  const clientOnly = new Set<string>();
  const visit = (rows: BundleEntry[]): void => {
    for (const row of rows) {
      if (row.disabled === true) continue;
      if (typeof row.name !== "string")
        throw new Error(`${selection.id}: bundle entry has no module name`);
      if (row.name === "cordis:group" || row.group) {
        if (!Array.isArray(row.config)) throw new Error(`${selection.id}: group requires entries`);
        visit(row.config);
        continue;
      }
      if (row.name.startsWith("cordis:")) continue;
      // File URLs also give client-modules the owning package when a package
      // does not export package.json. Node imports keep their original exports semantics.
      const exports = pkg.exports;
      const hasHost =
        pkg.main !== undefined ||
        typeof exports === "string" ||
        (exports !== undefined &&
          ("." in exports || Object.keys(exports).some((key) => !key.startsWith(".")))) ||
        existsSync(join(selection.directory, "index.js"));
      if (row.name === selection.id && !hasHost && pkg.dsh?.client?.platform === "web") {
        row.name = pathToFileURL(join(selection.directory, "package.json")).href;
        clientOnly.add(row.name);
      } else {
        const name = isAbsolute(row.name) ? pathToFileURL(row.name).href : row.name;
        row.name = resolveImport(name, base);
      }
      const owner = owningPackage(row.name);
      if (owner !== undefined && manifest(owner.directory).dsh?.client?.platform === "web")
        clients.set(owner.id, owner);
    }
  };
  visit(entries);
  return { ...selection, entries, clientOnly, clients: [...clients.values()] };
}
