/** Package the target Koffi binding even when npm installed only the build host's binding. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const extract = promisify(execFile);

export async function packKoffiBinding(options: {
  root: string;
  dependencies: string;
  platform: string;
  architecture: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const { root, dependencies, platform, architecture, fetch: download = fetch } = options;
  if (!["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(architecture))
    throw new Error(`Unsupported Koffi release target: ${platform}-${architecture}`);
  const name = `@koromix/koffi-${platform}-${architecture}`;
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const koffi = lock.packages["node_modules/koffi"];
  const artifact = lock.packages[`node_modules/${name}`];
  if (
    !artifact ||
    artifact.version !== koffi?.version ||
    artifact.version !== koffi?.optionalDependencies?.[name] ||
    artifact.resolved !==
      `https://registry.npmjs.org/${name}/-/koffi-${platform}-${architecture}-${artifact.version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(artifact.integrity)
  )
    throw new Error(`Invalid locked Koffi artifact: ${name}`);

  function copy(source: string): void {
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== artifact.version)
      throw new Error(`Koffi package metadata mismatch: ${name}`);
    cpSync(source, join(dependencies, name), {
      recursive: true,
      dereference: true,
      filter: (path) => !/\.(?:map|pdb)$/u.test(path),
    });
  }

  const installed = join(root, "node_modules", name);
  if (existsSync(installed)) {
    copy(installed);
    return;
  }

  // Cross-architecture builds fetch only the locked target package, without running install scripts.
  const temporary = await mkdtemp(join(tmpdir(), "codexhost-koffi-"));
  try {
    const response = await download(artifact.resolved, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Koffi download failed for ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity)
      throw new Error(`Koffi SHA-512 verification failed: ${name}`);
    await writeFile(join(temporary, "binding.tgz"), bytes);
    await extract("tar", ["-xzf", "binding.tgz"], { cwd: temporary, windowsHide: true });
    copy(join(temporary, "package"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
