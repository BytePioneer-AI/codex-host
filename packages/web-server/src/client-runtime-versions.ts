/** Version requirements are checked against the browser Host, never a plugin's install tree. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { satisfies, valid, validRange } from "semver";
import {
  WEB_RUNTIME_ALIASES,
  WEB_RUNTIME_PACKAGES,
} from "@codexhost/dsh-web-backend/plugin-resolution";

export const CLIENT_RUNTIME_VERSIONS_FILE = "client-runtime-versions.json";

/** Exact package versions composing a browser distribution and its imported DSH API baseline. */
export interface ClientRuntimeVersions {
  readonly version: 1;
  readonly dsh?: string;
  readonly packages: Readonly<Record<string, string>>;
}

export interface ClientRuntimeRequirement {
  readonly name: string;
  readonly range: string;
  readonly optional: boolean;
}

const VENDOR_PACKAGES: readonly string[] = [
  ...WEB_RUNTIME_PACKAGES,
  ...Object.keys(WEB_RUNTIME_ALIASES),
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`web-assets: ${label} must be an object`);
  return value as Record<string, unknown>;
}

function versionOf(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const pkg = object(JSON.parse(readFileSync(path, "utf8")), path);
  return typeof pkg.version === "string" ? (valid(pkg.version) ?? undefined) : undefined;
}

/** Resolve npm peers at the same Web application root used by Vite's singleton deduplication. */
export function sourceClientRuntimeVersions(
  repoRoot: string,
  directories: ReadonlyMap<string, string>,
  builtinIds: readonly string[],
  platformModules: Iterable<string>,
): ClientRuntimeVersions {
  const packages: Record<string, string> = {};
  const resolveFromWeb = createRequire(join(repoRoot, "apps/web/package.json"));
  const ids = new Set([...builtinIds, ...VENDOR_PACKAGES]);
  for (const specifier of platformModules)
    ids.add(
      specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/"),
    );
  for (const id of ids) {
    const directory = directories.get(id);
    let manifest: string;
    if (directory !== undefined) manifest = join(directory, "package.json");
    else {
      try {
        manifest = resolveFromWeb.resolve(`${WEB_RUNTIME_ALIASES[id] ?? id}/package.json`);
      } catch {
        continue;
      }
    }
    const version = versionOf(manifest);
    if (version !== undefined) packages[id] = version;
  }
  const dsh = versionOf(join(repoRoot, "import-manifest.json"));
  return { version: 1, ...(dsh === undefined ? {} : { dsh }), packages };
}

/** Old distributions without a snapshot have an unknown baseline, not the machine's npm tree. */
export function packedClientRuntimeVersions(packedRoot: string): ClientRuntimeVersions | undefined {
  const path = join(packedRoot, CLIENT_RUNTIME_VERSIONS_FILE);
  if (!existsSync(path)) return undefined;
  const snapshot = object(JSON.parse(readFileSync(path, "utf8")), path);
  if (snapshot.version !== 1)
    throw new Error(`web-assets: unsupported ${CLIENT_RUNTIME_VERSIONS_FILE}`);
  const packages = object(snapshot.packages, `${path} packages`);
  for (const [name, version] of Object.entries(packages)) {
    if (typeof version !== "string" || valid(version) === null)
      throw new Error(`web-assets: invalid runtime version for ${name}`);
  }
  if (
    snapshot.dsh !== undefined &&
    (typeof snapshot.dsh !== "string" || valid(snapshot.dsh) === null)
  )
    throw new Error("web-assets: invalid imported DSH runtime version");
  return {
    version: 1,
    ...(snapshot.dsh === undefined ? {} : { dsh: snapshot.dsh as string }),
    packages: packages as Record<string, string>,
  };
}

function runtimePeer(name: string): boolean {
  return (
    name === "react" ||
    name === "react-dom" ||
    name === "cordis" ||
    name === "dsh" ||
    name === "@deepseek-ai/dsh" ||
    name.startsWith("@deepseek-ai/dsh-") ||
    VENDOR_PACKAGES.includes(name)
  );
}

function workspacePeer(name: string, range: string): boolean {
  return (
    (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) &&
    ["workspace:^", "workspace:~", "workspace:*"].includes(range)
  );
}

/** Extract only Host-owned requirements; ordinary bundled library dependencies remain package-owned. */
export function clientRuntimeRequirements(
  pkg: Record<string, unknown>,
): ClientRuntimeRequirement[] {
  const requirements: ClientRuntimeRequirement[] = [];
  const append = (name: string, range: unknown, optional: boolean): void => {
    if (
      typeof range !== "string" ||
      range.trim() === "" ||
      (!workspacePeer(name, range) && validRange(range) === null)
    )
      throw new Error(`web-assets: ${String(pkg.name)} declares an invalid ${name} version range`);
    requirements.push({ name, range, optional });
  };
  const engines = pkg.engines === undefined ? {} : object(pkg.engines, "engines");
  if (engines.dsh !== undefined) append("dsh", engines.dsh, false);
  const peers =
    pkg.peerDependencies === undefined ? {} : object(pkg.peerDependencies, "peerDependencies");
  const meta =
    pkg.peerDependenciesMeta === undefined
      ? {}
      : object(pkg.peerDependenciesMeta, "peerDependenciesMeta");
  for (const [name, range] of Object.entries(peers)) {
    if (!runtimePeer(name)) continue;
    const details =
      meta[name] === undefined ? {} : object(meta[name], `peerDependenciesMeta.${name}`);
    append(name, range, details.optional === true);
  }
  return requirements;
}

/** DSH's compatibility policy includes prereleases and resolves DSH workspace peers to the Host. */
export function checkClientRuntimeVersions(
  id: string,
  requirements: readonly ClientRuntimeRequirement[],
  runtime: ClientRuntimeVersions | undefined,
): void {
  if (runtime === undefined && requirements.length > 0)
    throw new Error(
      `web-assets: ${id} declares runtime version requirements, but the browser Host version snapshot is unavailable`,
    );
  for (const { name, range, optional } of requirements) {
    const version =
      name === "dsh" || name === "@deepseek-ai/dsh" ? runtime?.dsh : runtime?.packages[name];
    if (version === undefined) {
      if (optional) continue;
      throw new Error(
        `web-assets: ${id} requires ${name}@${range}, but the browser Host does not provide ${name}`,
      );
    }
    if (
      !satisfies(version, workspacePeer(name, range) ? version : range, { includePrerelease: true })
    )
      throw new Error(
        `web-assets: ${id} requires ${name}@${range}, but the browser Host provides ${version}`,
      );
  }
}
