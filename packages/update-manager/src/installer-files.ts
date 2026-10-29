import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { requireSemanticVersion } from "./status.js";

export const INSTALLER_FILES_PATH = "app/codexhost-inno-files-v1.txt";
const HEADER = "codexhost-inno-files-v1";
export interface InstallerFile {
  path: string;
  sha256: string;
  bytes: number;
}
export interface InstallerFiles {
  version: string;
  target: string;
  files: InstallerFile[];
}
export function installerFilesText(value: InstallerFiles): string {
  const text = `${HEADER}\n${value.version}\n${value.target}\n${value.files.map((f) => `${f.sha256} ${f.bytes} ${f.path}`).join("\n")}\n`;
  parseInstallerFiles(text);
  return text;
}
export function parseInstallerFiles(text: string): InstallerFiles {
  if (Buffer.byteLength(text) > 1024 * 1024 || text.includes("\r") || !text.endsWith("\n"))
    throw new Error("Invalid installer file manifest encoding/size");
  const [header, version, target, ...lines] = text.slice(0, -1).split("\n");
  if (
    header !== HEADER ||
    !version ||
    !target ||
    !["windows-x64", "windows-arm64"].includes(target ?? "") ||
    lines.length === 0 ||
    lines.length > 2048
  )
    throw new Error("Unsupported installer recovery capability");
  requireSemanticVersion(version);
  const seen = new Set<string>();
  const files = lines.map((line) => {
    const match = /^([0-9a-f]{64}) ([0-9]+) ([A-Za-z0-9_@.\/-]+)$/u.exec(line);
    if (!match) throw new Error("Invalid installer file entry");
    const [, sha256, size, name] = match;
    if (
      !name ||
      !sha256 ||
      !size ||
      name.length > 240 ||
      name === INSTALLER_FILES_PATH ||
      (!/^(app|bin|runtime|libexec|licenses)\//u.test(name) && name !== "THIRD_PARTY_NOTICES.txt")
    )
      throw new Error("Installer file outside software scope");
    const parts = name.split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.endsWith(".") ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(p),
      )
    )
      throw new Error("Ambiguous installer file path");
    const key = name.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(Number(size)))
      throw new Error("Duplicate/oversized installer file");
    seen.add(key);
    return { path: name, sha256, bytes: Number(size) };
  });
  for (const file of files)
    for (let p = path.posix.dirname(file.path); p !== "."; p = path.posix.dirname(p))
      if (seen.has(p.toLowerCase())) throw new Error("Installer file/directory collision");
  for (const required of [
    "app/codexhost-distribution.json",
    "app/host-runtime.mjs",
    "bin/codexhost.exe",
    "runtime/node.exe",
    "libexec/codexhost-updater.exe",
  ])
    if (!seen.has(required)) throw new Error(`Installer manifest missing ${required}`);
  return { version, target, files };
}
export function parseInstallerSidecar(
  bytes: string,
  version: string,
  target: string,
  exeSha256: string,
): { text: string; manifest: InstallerFiles } {
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
    throw new Error("Installer descriptor exceeds size limit");
  const value = JSON.parse(bytes) as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "files,installerSha256,schemaVersion" ||
    value.schemaVersion !== 1 ||
    value.installerSha256 !== exeSha256 ||
    typeof value.files !== "string"
  )
    throw new Error("Installer sidecar does not bind this EXE/capability");
  const manifest = parseInstallerFiles(value.files);
  if (manifest.version !== version || manifest.target !== target)
    throw new Error("Installer sidecar version/target mismatch");
  return { text: value.files, manifest };
}
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root.toLowerCase(), file.toLowerCase());
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
export async function resolvedFuturePath(file: string): Promise<string> {
  const suffix: string[] = [];
  let ancestor = path.resolve(file);
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve installation path");
    suffix.push(path.basename(ancestor));
    ancestor = parent;
  }
}
export async function validateInstallerPaths(
  root: string,
  old: InstallerFiles,
  next: InstallerFiles,
  protectedRoots: readonly string[],
  checkInstalled: boolean,
): Promise<void> {
  const canonical = await realpath(root);
  if (!inside(canonical, root) || !inside(root, canonical))
    throw new Error("Installer root is redirected");
  const oldNames = new Set([...old.files.map((f) => f.path.toLowerCase()), INSTALLER_FILES_PATH]);
  const all = [...old.files, ...next.files, { path: INSTALLER_FILES_PATH, sha256: "", bytes: 0 }];
  const protections = await Promise.all(protectedRoots.map(resolvedFuturePath));
  for (const f of all) {
    const file = path.join(root, f.path);
    if (protections.some((p) => inside(p, file) || inside(file, p)))
      throw new Error("Installer software overlaps user data/plugin root");
    const resolved = await resolvedFuturePath(file);
    if (!inside(canonical, resolved) || !inside(file, resolved) || !inside(resolved, file))
      throw new Error("Installer software path is redirected");
    let current = root;
    for (const part of f.path.split("/")) {
      current = path.join(current, part);
      const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (info?.isSymbolicLink()) throw new Error("Installer reparse/link is unsupported");
      if (current !== file && info && !info.isDirectory())
        throw new Error("Installer file/directory transition is unsupported");
    }
    const info = await lstat(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (info && (!info.isFile() || info.nlink > 1))
      throw new Error("Installer target is not an exclusively owned regular file");
    if (checkInstalled && info && !oldNames.has(f.path.toLowerCase()))
      throw new Error("New installer file collides with user-owned content");
  }
  if (checkInstalled)
    for (const f of old.files) {
      const file = path.join(root, f.path);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if ((await lstat(file)).size !== f.bytes || hash.digest("hex") !== f.sha256)
        throw new Error("Installed software was modified; use manual original-directory repair");
    }
}
