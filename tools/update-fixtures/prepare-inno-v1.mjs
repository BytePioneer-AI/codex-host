import { readFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareInstallerRecovery } from "@codexhost/update-manager";
import { fileDigest } from "../../scripts/release/windows/manifest.mjs";
export async function prepareV1Materials(configPath, installRoot, operation, output) {
  if (
    process.platform !== "win32" ||
    process.env.CODEXHOST_DISPOSABLE_WINDOWS_USER !== "fixture-only"
  )
    throw new Error("Disposable Windows fixture required");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const releases = new Map(),
    sources = new Map();
  for (const material of [config.previous, config.next]) {
    if ((await fileDigest(material.path)) !== material.sha256)
      throw new Error("Fixture EXE changed");
    const sidecar = material.path.replace(/\.exe$/u, ".installer-recovery-v1.json");
    const exeName = `codexhost-${material.version}-windows-x64.exe`;
    const descriptorName = `codexhost-${material.version}-windows-x64.installer-recovery-v1.json`;
    const base = `https://github.com/BytePioneer-AI/codex-host/releases/download/v${material.version}/`;
    const assets = [];
    for (const [name, file] of [
      [exeName, material.path],
      [descriptorName, sidecar],
    ]) {
      const bytes = await readFile(file),
        sha = await fileDigest(file);
      const url = base + name;
      sources.set(url, { file, sha });
      assets.push({ name, size: bytes.length, digest: `sha256:${sha}`, downloadUrl: url });
    }
    releases.set(material.version, {
      version: material.version,
      releaseNotes: null,
      releaseNotesUrl: `https://github.com/BytePioneer-AI/codex-host/releases/tag/v${material.version}`,
      assets,
    });
  }
  await mkdir(operation, { recursive: true });
  await copyFile(config.next.path, path.join(operation, "update.exe"));
  const recovery = await prepareInstallerRecovery({
    installRoot,
    operation,
    installedVersion: config.previous.version,
    version: config.next.version,
    architecture: "x64",
    artifact: {
      url: `https://github.com/BytePioneer-AI/codex-host/releases/download/v${config.next.version}/codexhost-${config.next.version}-windows-x64.exe`,
      sha256: config.next.sha256,
    },
    release: async (version) => {
      const release = releases.get(version);
      if (!release) throw new Error("Unknown fixture version");
      return release;
    },
    download: async (source, name) => {
      const input = sources.get(source.url);
      if (!input || input.sha !== source.sha256) throw new Error("Unknown fixture artifact");
      const destination = path.join(operation, name);
      await copyFile(input.file, destination);
      if ((await fileDigest(destination)) !== source.sha256)
        throw new Error("Copied fixture artifact changed");
      return destination;
    },
  });
  await writeFile(output, JSON.stringify(recovery) + "\n", { flag: "wx" });
}
