import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { list } from "tar";

import { parseDistributionMetadata } from "./distribution-metadata.js";

export const CLI_PACKAGE = "@codexhost/cli";
const PLATFORM_NAMES = new Set(
  ["darwin", "win32", "linux"].flatMap((os) =>
    ["x64", "arm64"].map((arch) => `${CLI_PACKAGE}-${os}-${arch}`),
  ),
);

export function npmPlatformPackage(platform: NodeJS.Platform, architecture: string): string {
  const name = `${CLI_PACKAGE}-${platform}-${architecture}`;
  if (!PLATFORM_NAMES.has(name)) throw new Error("Unsupported npm platform package target");
  return name;
}

export async function fileDigest(
  file: string,
  algorithm: "sha256" | "sha512",
  signal?: AbortSignal,
): Promise<Buffer> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest();
}

/** Inspect without extracting or executing package contents. */
export async function inspectNpmArchive(
  file: string,
  name: string,
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
  signal: AbortSignal,
): Promise<number> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const documents = new Map<string, Buffer[]>();
  let unpacked = 0;
  const parser = list({
    strict: true,
    onReadEntry(entry) {
      const relative = entry.path.startsWith("package/")
        ? entry.path.slice(8).replace(/\/$/u, "")
        : "";
      const rootDirectory =
        entry.type === "Directory" && ["package", "package/"].includes(entry.path);
      if (
        (!relative && !rootDirectory) ||
        relative.includes("\\") ||
        relative.includes(":") ||
        Array.from(relative).some((character) => character.charCodeAt(0) < 32) ||
        (platform === "win32" &&
          relative
            .split("/")
            .some(
              (part) =>
                /[. ]$/u.test(part) ||
                /[<>"|?*]/u.test(part) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
            )) ||
        (relative !== "" &&
          relative.split("/").some((part) => part === "" || part === "." || part === "..")) ||
        !["File", "OldFile", "Directory"].includes(entry.type) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        (unpacked += entry.size) > 1024 * 1024 * 1024
      ) {
        parser.abort(new Error("npm archive has unsafe entries or exceeds its size limit"));
        return;
      }
      const key = platform === "win32" ? relative.toLowerCase() : relative;
      const parts = key.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        if (files.has(parent)) {
          parser.abort(new Error("npm archive has file/directory collisions"));
          return;
        }
        directories.add(parent);
      }
      if (entry.type === "Directory") {
        if (files.has(key)) {
          parser.abort(new Error("npm archive has file/directory collisions"));
          return;
        }
        directories.add(key);
        return;
      }
      if (files.has(key) || directories.has(key) || files.size + directories.size >= 50_000) {
        parser.abort(new Error("npm archive has duplicate entries or too many files"));
        return;
      }
      files.add(key);
      if (["package.json", "app/codexhost-distribution.json"].includes(relative)) {
        if (entry.size > 256 * 1024) {
          parser.abort(new Error("npm manifest exceeds its size limit"));
          return;
        }
        const chunks: Buffer[] = [];
        documents.set(relative, chunks);
        entry.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      }
    },
  });
  await pipeline(createReadStream(file), parser, { signal });
  const json = (path: string): Record<string, unknown> => {
    const chunks = documents.get(path);
    if (!chunks) throw new Error(`npm archive is missing ${path}`);
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid npm archive manifest");
    return value as Record<string, unknown>;
  };
  const manifest = json("package.json");
  if (manifest.name !== name || manifest.version !== version)
    throw new Error(`npm archive does not match ${name}@${version}`);
  for (const field of [
    "dependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    const value = manifest[field];
    if (
      value !== undefined &&
      value !== false &&
      (typeof value !== "object" || value === null || Object.keys(value).length !== 0)
    ) {
      throw new Error(
        `npm package ${name} has unsupported required installation materials (${field})`,
      );
    }
  }
  if (manifest.scripts && Object.keys(manifest.scripts).length > 0)
    throw new Error(`npm package ${name} requires unsupported lifecycle scripts`);
  const requireFiles = (paths: string[]): void => {
    for (const path of paths)
      if (!files.has(platform === "win32" ? path.toLowerCase() : path))
        throw new Error(`npm archive is missing ${path}`);
  };
  if (name === CLI_PACKAGE) {
    const bin = manifest.bin as Record<string, unknown> | undefined;
    const optional = manifest.optionalDependencies as Record<string, unknown> | undefined;
    if (
      bin?.codexhost !== "bin/codexhost.js" ||
      optional?.[npmPlatformPackage(platform, architecture)] !== version ||
      Object.entries(optional).some(([key, value]) => !PLATFORM_NAMES.has(key) || value !== version)
    ) {
      throw new Error("npm CLI platform dependencies do not match the prepared version");
    }
    requireFiles(["bin/codexhost.js"]);
  } else {
    if (
      name !== npmPlatformPackage(platform, architecture) ||
      JSON.stringify(manifest.os) !== JSON.stringify([platform]) ||
      JSON.stringify(manifest.cpu) !== JSON.stringify([architecture]) ||
      (manifest.optionalDependencies && Object.keys(manifest.optionalDependencies).length > 0)
    )
      throw new Error("npm platform package identity or dependency closure is invalid");
    const metadata = parseDistributionMetadata(json("app/codexhost-distribution.json"));
    const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
    if (
      metadata.version !== version ||
      metadata.distribution !== "npm" ||
      metadata.target !== `${os}-${architecture}`
    )
      throw new Error("npm distribution metadata does not match the prepared target");
    const suffix = platform === "win32" ? ".exe" : "";
    requireFiles([
      `bin/codexhost${suffix}`,
      `libexec/codexhost-shim${suffix}`,
      `libexec/codexhost-updater${suffix}`,
      ...(platform === "win32" ? ["libexec/codexhost-node-repl.exe"] : []),
      "app/host-runtime.mjs",
      "app/desktop-controller.mjs",
      "app/renderer-extension.js",
      "app/console-server.mjs",
      "app/console-web.js",
    ]);
  }
  return unpacked;
}
