import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  compareSemanticVersions,
  defaultUpdateStateDirectory,
  parseDistributionMetadata,
} from "@codexhost/update-manager";
import { runtimeStatusSchema, type RuntimeStatus } from "@codexhost/shared-contracts";

import { runRemoteSshSetup } from "./remote-ssh-setup.js";
import type { RemoteSshSetupParams, RemoteSshSetupResult } from "@codexhost/shared-contracts";

type Update = RuntimeStatus["update"];
interface Installation {
  version: string;
  distribution: string;
  digest: string;
}

async function runtimeMetadata(
  runtimePath: string,
): Promise<{ version: string; distribution: string }> {
  try {
    return parseDistributionMetadata(
      JSON.parse(
        await readFile(path.join(path.dirname(runtimePath), "codexhost-distribution.json"), "utf8"),
      ),
    );
  } catch (error) {
    // Source launches use workspace modules rather than a packaged distribution.
    const directory = path.dirname(runtimePath);
    if (
      path.basename(directory) !== "dist" ||
      path.basename(path.dirname(directory)) !== "host-runtime" ||
      path.basename(path.resolve(directory, "../..")) !== "packages"
    )
      throw error;
    const workspace = JSON.parse(
      await readFile(path.resolve(directory, "../../../package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (
      workspace.name !== "codexhost" ||
      typeof workspace.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(workspace.version)
    )
      throw error;
    return { version: `${workspace.version}-dev`, distribution: "development" };
  }
}

async function installation(runtimePath: string): Promise<Installation | null> {
  try {
    const [metadata, bytes] = await Promise.all([
      runtimeMetadata(runtimePath),
      readFile(runtimePath),
    ]);
    const parsed = metadata;
    const hash = createHash("sha256").update(bytes);
    // A reinstall can replace plugins at the same release number. Record the file
    // generation and bundled plugin catalog too; never compare this across hosts.
    const file = await stat(runtimePath);
    hash.update(`${file.ino}:${file.mtimeMs}:${file.ctimeMs}`);
    const plugins = path.join(path.dirname(runtimePath), "plugins");
    for (const name of (await readdir(plugins).catch(() => [])).sort()) {
      const candidate =
        name === "enabled.json"
          ? path.join(plugins, name)
          : path.join(plugins, name, "manifest.json");
      const contents = await readFile(candidate).catch(() => null);
      if (contents) hash.update(name).update(contents);
    }
    return { ...parsed, digest: hash.digest("hex") };
  } catch {
    return null;
  }
}

/** Shared by all connections in one process. Installed files are never reported as the running build. */
export class RuntimeMaintenance {
  readonly #running: Promise<Installation | null>;
  readonly #statusPath: string;
  #update: Update = { phase: "idle", targetVersion: null, error: null };
  #blocked = false;
  #starting: Promise<RuntimeStatus> | null = null;
  #startingVersion: string | null = null;
  constructor(
    readonly options: { runtimePath: string; remote: boolean; environment: NodeJS.ProcessEnv },
  ) {
    this.#running = installation(options.runtimePath);
    const home = options.environment.HOME ?? homedir();
    this.#statusPath = path.join(
      options.environment.CODEXHOST_DATA_DIR ?? path.join(home, ".codexhost", "remote", "data"),
      "remote-update.json",
    );
  }
  #sshPending = new Set<string>();
  async setupSsh(input: RemoteSshSetupParams): Promise<RemoteSshSetupResult> {
    if (this.options.remote) throw new Error("SSH installation must run from the local computer");
    const key = JSON.stringify([input.hostname, input.port, input.identity]);
    if (this.#sshPending.has(key))
      throw new Error("An SSH operation is already running for this connection");
    this.#sshPending.add(key);
    try {
      return await runRemoteSshSetup(this.options.runtimePath, this.options.environment, input);
    } finally {
      this.#sshPending.delete(key);
    }
  }
  get blocked(): boolean {
    return this.#blocked;
  }
  async operation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#blocked) throw new Error("Remote service is updating; reconnect shortly");
    return operation();
  }
  async #resources(): Promise<{
    node: string;
    npm: string;
    launcher: string;
    updater: string;
  } | null> {
    if (!this.options.remote || process.platform === "win32") return null;
    const root = path.dirname(path.dirname(this.options.runtimePath));
    const node = await realpath(process.execPath);
    const firstFile = async (candidates: string[]): Promise<string | null> => {
      for (const candidate of candidates) {
        try {
          const resolved = await realpath(candidate);
          await access(resolved);
          return resolved;
        } catch {
          /* Try another installed layout. */
        }
      }
      return null;
    };
    const npm = await firstFile([
      ...(this.options.environment.CODEXHOST_NPM_CLI_PATH
        ? [this.options.environment.CODEXHOST_NPM_CLI_PATH]
        : []),
      path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ...(this.options.environment.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, "npm")),
    ]);
    const launcher = await firstFile([
      path.resolve(root, "../cli/bin/codexhost.js"),
      path.resolve(root, "../../../bin/codexhost.js"),
    ]);
    const updater = path.join(root, "libexec/codexhost-updater");
    if (!npm || path.basename(npm) !== "npm-cli.js" || !launcher) return null;
    try {
      await access(updater);
    } catch {
      return null;
    }
    return { node, npm, launcher, updater };
  }
  async status(): Promise<RuntimeStatus> {
    const observedUpdate = this.#update;
    const [running, installed, resources] = await Promise.all([
      this.#running,
      installation(this.options.runtimePath),
      this.#resources(),
    ]);
    if (this.#update.phase === "idle" || this.#blocked) {
      try {
        const value: unknown = JSON.parse(await readFile(this.#statusPath, "utf8"));
        const parsed = runtimeStatusSchema.shape.update.parse(value);
        if (
          observedUpdate.phase === "idle" &&
          ["installing", "restarting"].includes(parsed.phase)
        ) {
          const pid = (value as { updaterPid?: unknown }).updaterPid;
          let alive = false;
          if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch (error) {
              alive = (error as NodeJS.ErrnoException).code === "EPERM";
            }
          }
          if (!alive) {
            parsed.phase = "failed";
            parsed.error = "The previous remote update was interrupted; retry the update";
          }
        }
        if (this.#update === observedUpdate) this.#update = parsed;
        if (["failed", "succeeded"].includes(this.#update.phase)) this.#blocked = false;
      } catch {
        /* No previous operation, or an atomic replacement is in progress. */
      }
    }
    return {
      runningVersion: running?.version ?? null,
      installedVersion: installed?.version ?? null,
      restartRequired:
        !!running &&
        !!installed &&
        (running.version !== installed.version || running.digest !== installed.digest),
      remote: this.options.remote,
      updateSupported: !!resources && installed?.distribution === "npm",
      update: { ...this.#update },
    };
  }
  start(version: string): Promise<RuntimeStatus> {
    if (this.#starting) {
      if (this.#startingVersion !== version)
        return Promise.reject(new Error("Another remote update is already pending"));
      return this.#starting;
    }
    this.#startingVersion = version;
    this.#starting = this.#schedule(version).finally(() => {
      this.#starting = null;
      this.#startingVersion = null;
    });
    return this.#starting;
  }
  async #schedule(version: string): Promise<RuntimeStatus> {
    const status = await this.status();
    if (!status.updateSupported || !status.installedVersion)
      throw new Error("Remote update requires an npm installation with the current updater");
    if (compareSemanticVersions(version, status.installedVersion) < 0)
      throw new Error("Remote downgrades are not automatic; update this computer first");
    if (["installing", "restarting"].includes(this.#update.phase)) {
      if (this.#update.targetVersion !== version)
        throw new Error("Another remote update is already pending");
      return status;
    }
    if (version === status.installedVersion && !status.restartRequired) return status;
    this.#blocked = true;
    this.#update = { phase: "installing", targetVersion: version, error: null };
    try {
      await this.#launch(version);
    } catch (error) {
      this.#blocked = false;
      this.#update = {
        phase: "failed",
        targetVersion: version,
        error: String(error).slice(0, 500),
      };
      throw error;
    }
    return this.status();
  }

  async #launch(version: string): Promise<void> {
    // Recheck the installed version before launching the updater.
    const installed = await installation(this.options.runtimePath);
    if (!installed || compareSemanticVersions(version, installed.version) < 0) {
      throw new Error("The remote installation changed; refresh versions before retrying");
    }
    const restartOnly = version === installed.version;
    const resources = await this.#resources();
    if (!resources) throw new Error("Remote updater is unavailable");
    const directory = path.dirname(this.#statusPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(path.join(directory, "update-remote-"));
    const helper = path.join(work, "codexhost-updater");
    await copyFile(resources.updater, helper);
    await chmod(helper, 0o700);
    const request = path.join(work, "request.json");
    this.#update = { phase: "installing", targetVersion: version, error: null };
    await writeFile(this.#statusPath, JSON.stringify(this.#update), { mode: 0o600 });
    await writeFile(
      request,
      JSON.stringify({
        version,
        installedVersion: installed.version,
        restartOnly,
        node: resources.node,
        npm: resources.npm,
        launcher: resources.launcher,
        statusPath: this.#statusPath,
        packageRoot: path.dirname(path.dirname(this.options.runtimePath)),
        lockDirectory: defaultUpdateStateDirectory(process.platform, this.options.environment),
      }),
      { mode: 0o600 },
    );
    const child = spawn(helper, ["remote", "--request", request], {
      detached: true,
      stdio: "ignore",
      env: this.options.environment,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.once("exit", (code) => {
      // Usually this process is replaced before the helper exits. On install failure keep it usable.
      void this.status()
        .then(async () => {
          if (code !== 0 && !["failed", "succeeded"].includes(this.#update.phase)) {
            this.#update = {
              phase: "failed",
              targetVersion: version,
              error: "Remote updater exited before completion; retry the update",
            };
            await writeFile(this.#statusPath, JSON.stringify(this.#update), { mode: 0o600 });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.#blocked = false;
        });
    });
    child.unref();
  }
}
