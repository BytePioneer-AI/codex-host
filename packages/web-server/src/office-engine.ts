/** Release-only Office engine installation, owned by the Web process rather than a preview. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

interface OfficeEngineArtifact {
  name: string;
  version: string;
  url: string;
  integrity: string;
}

const extract = promisify(execFile);

/** The artifact list comes from the release's locked manifest; tests supply a local source. */
export function createOfficeEngine(
  dataRoot: string,
  artifacts: OfficeEngineArtifact[],
): () => boolean {
  const target = process.platform === "linux" ? "wasm" : `${process.platform}-${process.arch}`;
  const artifact = artifacts.find(({ name }) => name === `@deepseek-ai/libreoffice-kit-${target}`);
  const root = join(dataRoot, "office-engine");
  let ready = false;
  let downloading: Promise<void> | undefined;
  let failure: Error | undefined;

  function activate(modules: string): void {
    process.env.NODE_PATH = modules;
    // resolveEngine uses require.resolve; keep the search path, not the child environment.
    try {
      (Module as typeof Module & { _initPaths(): void })._initPaths();
    } finally {
      delete process.env.NODE_PATH;
    }
    ready = true;
  }

  async function install(engine: OfficeEngineArtifact): Promise<void> {
    const temporary = join(root, ".download");
    try {
      // A Web restart discards any incomplete download from the previous process.
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true });
      const response = await fetch(engine.url);
      if (!response.ok) throw new Error(`Office engine download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== engine.integrity)
        throw new Error("Office engine SHA-512 verification failed");
      const archive = join(temporary, "engine.tgz");
      await writeFile(archive, bytes);
      await extract("tar", ["-xzf", "engine.tgz"], { cwd: temporary });
      const modules = join(root, engine.version, "node_modules");
      await mkdir(join(modules, "@deepseek-ai"), { recursive: true });
      await rename(join(temporary, "package"), join(modules, engine.name));
      for (const version of await readdir(root)) {
        if (version !== engine.version && version !== ".download")
          await rm(join(root, version), { recursive: true, force: true });
      }
      activate(modules);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return () => {
    if (failure) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    if (ready) return true;
    if (!artifact) throw new Error(`No released Office engine for ${target}`);
    if (downloading) return false;
    const modules = join(root, artifact.version, "node_modules");
    if (existsSync(join(modules, artifact.name, "package.json"))) {
      activate(modules);
      return true;
    }
    downloading = install(artifact)
      .catch((error: Error) => {
        failure = error;
      })
      .finally(() => {
        downloading = undefined;
      });
    return false;
  };
}
