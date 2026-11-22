/** Read precompiled DSH browser packages without importing their Host entry points. */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  clientRuntimeRequirements,
  type ClientRuntimeRequirement,
} from "./client-runtime-versions.ts";

/** Package selection from the Web plugin profile. */
export interface ExternalClientPluginSource {
  readonly id: string;
  readonly directory: string;
}

/** Browser graph fields shared by built-in and installed packages. */
export interface ClientAssetManifest {
  inject?: string[];
  external?: string[];
  immediately?: boolean;
}

/** Shell-owned module identities available to every browser plugin. */
export const EXTERNAL_CLIENT_PLATFORM_MODULES: ReadonlySet<string> = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);

const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u;

/** Validated browser metadata; native ClientModules owns snapshots and revisions. */
export interface ExternalClientAssets {
  readonly id: string;
  readonly directory: string;
  readonly clientPath: string;
  readonly manifest: ClientAssetManifest;
  readonly requirements: readonly ClientRuntimeRequirement[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`web-assets: ${label} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
    throw new Error(`web-assets: ${label} must be an array of non-empty strings`);
  return value as string[];
}

function packageFile(directory: string, target: string): string {
  const path = realpathSync(target);
  const fromRoot = relative(directory, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error(`web-assets: package asset escapes ${directory}: ${target}`);
  if (!statSync(path).isFile())
    throw new Error(`web-assets: package asset is not a file: ${target}`);
  return path;
}

/** Read only the manifest and published browser artifacts of an installed package. */
export function readExternalClientAssets(
  selection: ExternalClientPluginSource,
): ExternalClientAssets {
  if (!PACKAGE_ID.test(selection.id) || selection.id.endsWith("/client"))
    throw new Error(`web-assets: invalid browser plugin id ${selection.id}`);
  if (EXTERNAL_CLIENT_PLATFORM_MODULES.has(selection.id))
    throw new Error(`web-assets: external plugin cannot replace platform module ${selection.id}`);
  const directory = realpathSync(selection.directory);
  const pkg = object(
    JSON.parse(readFileSync(packageFile(directory, resolve(directory, "package.json")), "utf8")),
    `${selection.id} package.json`,
  );
  if (pkg.name !== selection.id)
    throw new Error(
      `web-assets: selected plugin ${selection.id} has package name ${String(pkg.name)}`,
    );
  const client = object(
    object(pkg.dsh, `${selection.id} dsh`).client,
    `${selection.id} dsh.client`,
  );
  const requirements = clientRuntimeRequirements(pkg);
  if (client.platform !== "web")
    throw new Error(`web-assets: ${selection.id} declares no web client`);
  const inject = strings(client.inject, `${selection.id} dsh.client.inject`);
  const external = strings(client.external, `${selection.id} dsh.client.external`);
  if (client.immediately !== undefined && typeof client.immediately !== "boolean")
    throw new Error(`web-assets: ${selection.id} dsh.client.immediately must be a boolean`);
  const manifest: ClientAssetManifest = {
    ...(inject === undefined ? {} : { inject }),
    ...(external === undefined ? {} : { external }),
    ...(client.immediately === undefined ? {} : { immediately: client.immediately }),
  };
  const exported = object(pkg.exports, `${selection.id} exports`)["./client"];
  const target =
    typeof exported === "string" ? exported : object(exported, `${selection.id} ./client`).default;
  if (
    typeof target !== "string" ||
    !target.startsWith("./") ||
    target.includes("\\") ||
    target.includes("\0") ||
    target
      .slice(2)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error(`web-assets: ${selection.id} exports no package-local ./client bundle`);
  const clientPath = packageFile(directory, resolve(directory, target));
  for (const name of readdirSync(dirname(clientPath))) {
    if (CLIENT_CHUNK.test(name)) packageFile(directory, resolve(dirname(clientPath), name));
  }
  return {
    id: selection.id,
    directory,
    clientPath,
    manifest,
    requirements,
  };
}

/** Every declared browser import must resolve to a graph row or the shared shell instance. */
export function checkExternalClientDependencies(
  plugins: readonly ExternalClientAssets[],
  available: ReadonlySet<string>,
): void {
  for (const plugin of plugins) {
    for (const request of [
      ...(plugin.manifest.inject ?? []),
      ...(plugin.manifest.external ?? []),
    ]) {
      const id = request.endsWith("/client") ? request.slice(0, -"/client".length) : request;
      if (!EXTERNAL_CLIENT_PLATFORM_MODULES.has(request) && !available.has(id))
        throw new Error(`web-assets: ${plugin.id} requires unavailable browser module ${request}`);
    }
  }
}
