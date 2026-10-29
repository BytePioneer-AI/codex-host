import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { INSTALLER_FILES_PATH, installerFilesText } from "@codexhost/update-manager";

export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function writeInstallerManifest(payloadRoot, version, target) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name),
        relative = path.relative(payloadRoot, absolute).split(path.sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("Installer payload cannot contain links");
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) {
        if (relative !== INSTALLER_FILES_PATH)
          files.push({ path: relative, bytes: info.size, sha256: await fileDigest(absolute) });
      } else throw new Error("Installer payload contains special files");
    }
  }
  await walk(payloadRoot);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const text = installerFilesText({ version, target, files });
  await writeFile(path.join(payloadRoot, INSTALLER_FILES_PATH), text);
  return text;
}
export async function writeInstallerSidecar(exe, payloadRoot) {
  const sidecar = exe.replace(/\.exe$/u, ".installer-recovery-v1.json");
  if (sidecar === exe) throw new Error("Expected EXE artifact");
  await writeFile(
    sidecar,
    JSON.stringify({
      schemaVersion: 1,
      installerSha256: await fileDigest(exe),
      files: await readFile(path.join(payloadRoot, INSTALLER_FILES_PATH), "utf8"),
    }) + "\n",
  );
  return sidecar;
}
