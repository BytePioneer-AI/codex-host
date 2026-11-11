import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { codexhostDataDirectory } from "./external-clients.js";
import { discoverProjects, type ProjectScan } from "./project-inventory.js";

const CACHE_MS = 60_000;
const TOOL_COMMANDS = ["git", "node", "python3", "cargo", "go", "docker", "bun", "java"];

interface InventorySettings {
  id: string;
  name: string;
  aliases: string[];
  projectRoots: string[];
  defaultWorkspace?: string;
}

interface ToolVersion {
  command: string;
  available: boolean;
  version?: string;
}

function text(value: unknown, field: string, fallback?: string): string {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim() || result.length > 256)
    throw new DelegationControlError("INVALID_ARGUMENT", `Invalid inventory setting: ${field}`);
  return result.trim();
}

function strings(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 16)
    throw new DelegationControlError("INVALID_ARGUMENT", `Invalid inventory setting: ${field}`);
  return [...new Set(value.map((item) => text(item, field)))];
}

function absolute(value: string, field: string): string {
  if (!path.isAbsolute(value))
    throw new DelegationControlError("INVALID_ARGUMENT", `${field} must contain absolute paths`);
  return path.resolve(value);
}

function refresh(input: Record<string, unknown>): boolean {
  if (input.refresh !== undefined && typeof input.refresh !== "boolean")
    throw new DelegationControlError("INVALID_ARGUMENT", "refresh must be a boolean");
  return input.refresh === true;
}

function integer(value: unknown, name: string, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < 0 || (result as number) > maximum)
    throw new DelegationControlError("INVALID_ARGUMENT", `${name} is out of range`);
  return result as number;
}

async function directory(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

function toolVersion(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ToolVersion> {
  const executable = command === "node" ? process.execPath : command;
  const args =
    command === "go"
      ? ["version"]
      : command === "xcodebuild" || command === "java"
        ? ["-version"]
        : ["--version"];
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env: { ...environment, RUSTUP_AUTO_INSTALL: "0", GOTOOLCHAIN: "local" },
        timeout: 2_000,
        maxBuffer: 32_768,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const version = (stdout || stderr).trim().split("\n")[0]?.slice(0, 200);
        resolve({ command, available: !error, ...(!error && version ? { version } : {}) });
      },
    );
  });
}

/** Read-only device facts and project discovery for an authenticated external client. */
export class HostInventory {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #home: string;
  readonly #settingsPath: string;
  #tools:
    { expires: number; value: Promise<{ observedAt: string; tools: ToolVersion[] }> } | undefined;
  #projects: { key: string; expires: number; value: Promise<ProjectScan> } | undefined;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
    this.#home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
    this.#settingsPath = path.join(codexhostDataDirectory(environment), "host-inventory.json");
  }

  async #settings(): Promise<InventorySettings> {
    let settings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#settingsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new DelegationControlError("INVALID_ARGUMENT", "Invalid host-inventory.json");
    }
    const defaultWorkspace =
      settings.defaultWorkspace === undefined
        ? path.join(this.#home, "Developer", "AgentWorkSpace", "Personal")
        : absolute(text(settings.defaultWorkspace, "defaultWorkspace"), "defaultWorkspace");
    return {
      id: text(settings.id, "id", os.hostname()),
      name: text(settings.name, "name", os.hostname()),
      aliases: strings(settings.aliases, "aliases", []),
      projectRoots: strings(settings.projectRoots, "projectRoots", [
        path.join(this.#home, "Developer", "Repos"),
      ]).map((root) => absolute(root, "projectRoots")),
      ...((await directory(defaultWorkspace)) ? { defaultWorkspace } : {}),
    };
  }

  async info(input: Record<string, unknown> = {}) {
    const force = refresh(input);
    const settings = await this.#settings();
    if (force || !this.#tools || this.#tools.expires <= Date.now()) {
      const commands =
        process.platform === "darwin" ? [...TOOL_COMMANDS, "swift", "xcodebuild"] : TOOL_COMMANDS;
      this.#tools = {
        expires: Date.now() + CACHE_MS,
        value: Promise.all(
          commands.map((command) => toolVersion(command, this.#environment, this.#home)),
        ).then((tools) => ({ tools, observedAt: new Date().toISOString() })),
      };
    }
    const tools = await this.#tools.value;
    return {
      ...settings,
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: { model: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length },
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      freeMemoryGiB: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
      ...tools,
    };
  }

  async projects(input: Record<string, unknown> = {}) {
    const force = refresh(input);
    if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 256))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "query must be a string of at most 256 characters",
      );
    const offset = integer(input.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(input.limit, "limit", 50, 100);
    if (limit === 0) throw new DelegationControlError("INVALID_ARGUMENT", "limit must be positive");
    const settings = await this.#settings();
    const key = JSON.stringify(settings.projectRoots);
    if (
      force ||
      !this.#projects ||
      this.#projects.key !== key ||
      this.#projects.expires <= Date.now()
    ) {
      this.#projects = {
        key,
        expires: Date.now() + CACHE_MS,
        value: discoverProjects(settings.projectRoots, this.#environment),
      };
    }
    const scan = await this.#projects.value;
    const query = typeof input.query === "string" ? input.query.trim().toLocaleLowerCase() : "";
    const matches = scan.projects.filter((project) =>
      [
        project.name,
        project.cwd,
        project.remote,
        project.description,
        ...project.technologies,
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
    );
    const next = offset + limit;
    return {
      deviceId: settings.id,
      projectRoots: settings.projectRoots,
      observedAt: scan.observedAt,
      unavailableRoots: scan.unavailableRoots,
      truncated: scan.truncated,
      projects: matches.slice(offset, next),
      total: matches.length,
      nextOffset: next < matches.length ? next : null,
    };
  }
}
