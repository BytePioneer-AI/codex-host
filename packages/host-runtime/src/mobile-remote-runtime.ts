import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface MobileRemoteRuntime {
  executable: string;
  socketPath: string;
  close(): Promise<void>;
}

/** Distribution-owned native bridge. Never download code or borrow another Host's socket. */
export async function prepareMobileRemoteRuntime(input: {
  stockCodexPath: string;
  environment: NodeJS.ProcessEnv;
  hostRuntimeUrl?: string;
  diagnose(message: string): void;
  platform?: NodeJS.Platform;
  architecture?: string;
}): Promise<MobileRemoteRuntime | undefined> {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  if (
    platform !== "darwin" ||
    architecture !== "arm64" ||
    input.environment.CODEXHOST_MOBILE_REMOTE === "0"
  )
    return undefined;
  const runtimePath = input.hostRuntimeUrl
    ? fileURLToPath(input.hostRuntimeUrl)
    : input.environment.CODEXHOST_HOST_RUNTIME_PATH;
  if (!runtimePath || !path.isAbsolute(runtimePath)) return undefined;
  const directory = path.join(path.dirname(runtimePath), "mobile-codex");
  try {
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error("Invalid packaged mobile Codex manifest", { cause: error });
    }
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      !("files" in metadata) ||
      !("platform" in metadata) ||
      !("architecture" in metadata) ||
      typeof metadata.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
      typeof metadata.files !== "object" ||
      metadata.files === null ||
      metadata.platform !== platform ||
      metadata.architecture !== architecture
    )
      throw new Error("Invalid packaged mobile Codex manifest");
    const version = await promisify(execFile)(input.stockCodexPath, ["--version"], {
      env: input.environment,
      timeout: 10000,
      maxBuffer: 4096,
    });
    if (version.stdout.trim() !== `codex-cli ${metadata.version}`) {
      input.diagnose(
        "Mobile Harness unavailable: installed Codex version differs from the packaged bridge; using official Codex.",
      );
      return undefined;
    }
    const executable = path.join(directory, "bin/codex");
    for (const name of [
      "bin/codex",
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/zsh/bin/zsh",
      "codex-package.json",
    ]) {
      const expected = (metadata.files as Record<string, unknown>)[name];
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error(`Missing mobile Codex integrity metadata: ${name}`);
      const binary = path.join(directory, name);
      const info = await stat(binary);
      if (!info.isFile() || (name !== "codex-package.json" && (info.mode & 0o111) === 0))
        throw new Error(`Mobile Codex ${name} is unavailable`);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(binary)) hash.update(chunk);
      if (hash.digest("hex") !== expected)
        throw new Error(`Mobile Codex ${name} integrity check failed`);
    }
    const socketDirectory = await mkdtemp(path.join(tmpdir(), "ch-mobile-"));
    return {
      executable,
      socketPath: path.join(socketDirectory, "host.sock"),
      close: () => rm(socketDirectory, { recursive: true, force: true }),
    };
  } catch {
    input.diagnose(
      "Mobile Harness unavailable: packaged runtime is incomplete or invalid; using official Codex.",
    );
    return undefined;
  }
}
