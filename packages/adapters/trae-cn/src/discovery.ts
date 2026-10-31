import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { environmentValue } from "@codexhost/harness-discovery";
import { readEndpoint, type Endpoint } from "./protocol.js";
import { record, TraeError } from "./errors.js";

export interface BridgeOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  app?: string;
  timeoutMs?: number;
}

export function sameDirectory(left: string, right: string, platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const normalized = paths.resolve(value).replace(/[\\/]$/, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function matchesInstallation(endpoint: Endpoint, selected?: string): Promise<boolean> {
  const productFile = path.join(endpoint.application.root, "product.json");
  const stats = await lstat(productFile);
  if (!stats.isFile() || stats.size > 1024 * 1024) return false;
  const product: unknown = JSON.parse(await readFile(productFile, "utf8"));
  if (!record(product) || product.applicationName !== "trae-cn") return false;
  if (!selected) return true;
  return [
    endpoint.application.executable,
    endpoint.application.root,
    process.platform === "darwin"
      ? path.resolve(endpoint.application.root, "..", "..", "..")
      : path.resolve(endpoint.application.root, "..", ".."),
  ].some((candidate) => sameDirectory(candidate, selected));
}

export function bridgeDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environmentValue(environment, "CODEXHOST_TRAE_CN_BRIDGE_DIR");
  if (configured) {
    if (!path.isAbsolute(configured))
      throw new TraeError("configurationRequired", "The TRAE CN bridge directory must be absolute");
    return configured;
  }
  const home =
    environmentValue(environment, process.platform === "win32" ? "USERPROFILE" : "HOME") ||
    os.homedir();
  return path.join(home, ".codexhost", "native-bridges", "trae-cn");
}

/** Read only owner-private metadata; never launch Desktop or create a native session. */
export async function discoverBridges(options: BridgeOptions): Promise<Endpoint[]> {
  const environment = options.environment ?? process.env;
  const directory = bridgeDirectory(environment);
  const candidates: Endpoint[] = [];
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files.sort()) {
    if (!/^bridge-\d+-[a-f0-9-]+\.json$/.test(file)) continue;
    try {
      const filename = path.join(directory, file);
      const stats = await lstat(filename);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384) continue;
      if (
        process.platform !== "win32" &&
        ((stats.mode & 0o077) !== 0 || (process.getuid && stats.uid !== process.getuid()))
      )
        continue;
      const endpoint = readEndpoint(JSON.parse(await readFile(filename, "utf8")));
      if (!endpoint.workspaceFolders.some((folder) => sameDirectory(folder, options.cwd))) continue;
      process.kill(endpoint.pid, 0);
      if (!(await matchesInstallation(endpoint, options.app))) continue;
      candidates.push(endpoint);
    } catch {
      /* A stale or incomplete discovery file is not an installed runtime. */
    }
  }
  return candidates;
}
