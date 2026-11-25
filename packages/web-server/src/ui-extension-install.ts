/** Install prebuilt packages in a dedicated directory without executing package scripts. */
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandInvocation,
  resolveHarnessExecutable,
  withNodeRuntimeOnPath,
} from "@codexhost/harness-discovery";
import { webUiExtensionRegistrySchema } from "@codexhost/shared-contracts";
import semver from "semver";
import { parseInstallSpec } from "./dsh-install-spec.ts";

export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export interface ExtensionInstallSpec {
  readonly spec: string;
  /** A GitHub source is fetched as an archive, never through npm's Git preparation. */
  readonly installSpec?: string;
  readonly expected?: { name: string; version?: string };
}

export async function extensionInstallSpec(input: string): Promise<ExtensionInstallSpec> {
  const spec = input.trim();
  if (/[\u0000-\u001f\u007f]/u.test(spec) || spec.length > 4096)
    throw new Error("The extension source contains invalid characters or is too long.");
  if (/^(?:git\+)?https?:\/\/github\.com\//iu.test(spec))
    return { spec, installSpec: githubArchive(spec) };
  const parsed = parseInstallSpec(spec);
  if (parsed.kind === "registry") {
    const exact = parsed.range === undefined ? null : semver.parse(parsed.range);
    const version =
      exact && exact.version + (exact.build.length ? `+${exact.build.join(".")}` : "");
    if (
      parsed.range !== undefined &&
      !semver.validRange(parsed.range) &&
      !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(parsed.range)
    )
      throw new Error("Use an npm package name, version, range, or tag.");
    return { spec, expected: { name: parsed.name, ...(version ? { version } : {}) } };
  }
  if (parsed.kind === "git") return { spec, installSpec: githubArchive(spec) };
  if (parsed.path !== undefined) {
    const info = await stat(parsed.path).catch(() => undefined);
    if (
      (parsed.kind === "path" && info?.isDirectory()) ||
      (parsed.kind === "tarball" && info?.isFile())
    )
      return { spec, ...(spec !== parsed.path ? { installSpec: parsed.path } : {}) };
    throw new Error("Use an existing absolute plugin directory or a prebuilt .tgz/.tar.gz file.");
  }
  throw new Error(
    "Use an npm package name, a GitHub repository, or an absolute local plugin path.",
  );
}

function githubArchive(spec: string): string {
  let value = spec.replace(/^git\+/iu, "");
  if (/^github:/iu.test(value)) value = value.replace(/^github:/iu, "https://github.com/");
  if (/^git@github\.com:/iu.test(value))
    value = value.replace(/^git@github\.com:/iu, "https://github.com/");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Use a public GitHub repository URL, optionally followed by #branch, #tag, or #commit.",
    );
  }
  const parts = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/u.exec(url.pathname);
  const owner = parts?.[1];
  const repository = parts?.[2]?.replace(/\.git$/u, "");
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    !owner ||
    !repository ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".."
  )
    throw new Error(
      "Only public GitHub repository URLs are supported; use a local directory for other Git hosts.",
    );
  let ref: string;
  try {
    ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : "HEAD";
  } catch {
    throw new Error("The GitHub branch, tag, or commit is invalid.");
  }
  if (!ref || /[\s\u0000-\u001f\u007f\\?#:]/u.test(ref))
    throw new Error("The GitHub branch, tag, or commit is invalid.");
  return `https://codeload.github.com/${owner}/${repository}/tar.gz/${encodeURIComponent(ref)}`;
}

export async function installExtensionPackage(
  directory: string,
  spec: string,
  registry = OFFICIAL_NPM_REGISTRY,
): Promise<void> {
  const selectedRegistry = webUiExtensionRegistrySchema.parse(registry);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, name: "codexhost-ui-extension", version: "0.0.0" }),
  );
  // Git dependencies can spawn another npm process; keep scripts disabled there as well.
  const environment = withNodeRuntimeOnPath(process.env);
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_ignore_scripts") Reflect.deleteProperty(environment, key);
  }
  environment.npm_config_ignore_scripts = "true";
  const scope = /^(@[^/]+)\//u.exec(spec)?.[1];
  // Resolve before entering the package directory: a bare npm.cmd can derive
  // its own prefix from cwd on Windows rather than from the installed shim.
  const npm = resolveHarnessExecutable(
    { id: "npm", command: process.platform === "win32" ? "npm.cmd" : "npm" },
    { environment },
  );
  if (!npm) throw new Error("npm is unavailable on the installation PATH.");
  // Command-line options override inherited npm configuration for execution and installation scope.
  const invocation = commandInvocation(
    npm.executable,
    [
      "install",
      "--prefix",
      directory,
      "--global=false",
      "--workspaces=false",
      "--ignore-scripts",
      "--install-links",
      "--omit=dev",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--registry",
      selectedRegistry,
      ...(scope ? [`--${scope}:registry=${selectedRegistry}`] : []),
      "--",
      spec,
    ],
    environment,
  );
  await new Promise<void>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.arguments,
      {
        cwd: directory,
        env: environment,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error) => {
        if (error)
          reject(
            new Error(
              error.killed
                ? "Package installation timed out."
                : "Package installation failed. Check the package version, npm availability and registry access.",
            ),
          );
        else resolve();
      },
    );
  });
}
