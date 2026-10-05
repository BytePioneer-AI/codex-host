import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  harnessLaunchPathSchema,
  harnessLaunchSettingsSchema,
  harnessConnectionModeSchema,
  harnessPluginIdSchema,
  type HarnessLaunchSettings,
  type HarnessConnectionMode,
} from "@codexhost/shared-contracts";

const storedSettingsSchema = harnessLaunchSettingsSchema.omit({ restartRequired: true });
type StoredSettings = Omit<HarnessLaunchSettings, "restartRequired">;

/** Per-plugin files avoid lost updates between independently running Host connections. */
export class HarnessLaunchSettingsStore {
  readonly #directory: string;
  readonly #initial = new Map<string, Promise<StoredSettings>>();

  constructor(environment: NodeJS.ProcessEnv) {
    this.#directory = path.join(
      environment.CODEXHOST_DATA_DIR
        ? path.resolve(environment.CODEXHOST_DATA_DIR)
        : path.join(os.homedir(), ".codexhost"),
      "harness-launch-settings",
    );
  }

  #file(id: string): string {
    return path.join(this.#directory, `${harnessPluginIdSchema.parse(id)}.json`);
  }

  async #read(id: string): Promise<StoredSettings> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#file(id), "utf8"));
      const value = storedSettingsSchema.parse(typeof raw === "string" ? { path: raw } : raw);
      if (value.path !== null && !path.isAbsolute(value.path))
        throw new Error("Expected an absolute entrypoint path");
      return value;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { path: null };
      throw new Error("Could not read Harness launch settings");
    }
  }

  /** Capture the value used to construct this Host's Adapter; changes require a restart. */
  async #initialSettings(id: string): Promise<StoredSettings> {
    let initial = this.#initial.get(id);
    if (!initial) {
      initial = this.#read(id);
      this.#initial.set(id, initial);
    }
    return initial;
  }

  async initialCommand(id: string): Promise<string | undefined> {
    return (await this.#initialSettings(id)).path ?? undefined;
  }

  async initialConnectionMode(id: string): Promise<HarnessConnectionMode | undefined> {
    return (await this.#initialSettings(id)).connectionMode;
  }

  async get(id: string, includeConnectionMode = false): Promise<HarnessLaunchSettings> {
    const initial = await this.#initialSettings(id);
    const value = await this.#read(id);
    return {
      ...value,
      ...(includeConnectionMode ? { connectionMode: value.connectionMode ?? "web" } : {}),
      restartRequired:
        value.path !== initial.path || value.connectionMode !== initial.connectionMode,
    };
  }

  async set(
    id: string,
    value: string | null | undefined,
    connectionMode?: HarnessConnectionMode,
  ): Promise<HarnessLaunchSettings> {
    await this.#initialSettings(id);
    const previous = await this.#read(id);
    const settings: StoredSettings = {
      ...previous,
      ...(value === undefined
        ? {}
        : { path: value === null ? null : harnessLaunchPathSchema.parse(value) }),
      ...(connectionMode === undefined
        ? {}
        : { connectionMode: harnessConnectionModeSchema.parse(connectionMode) }),
    };
    const file = this.#file(id);
    if (value !== undefined && settings.path !== null) {
      if (!path.isAbsolute(settings.path))
        throw new Error("Use an absolute entrypoint path without arguments");
      const metadata = await stat(settings.path).catch(() => undefined);
      if (!metadata?.isDirectory() && !metadata?.isFile())
        throw new Error("The installation path must be an existing directory on this Host");
    }
    if (settings.path === null && settings.connectionMode === undefined) {
      await rm(file, { force: true });
    } else {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify(settings.connectionMode === undefined ? settings.path : settings)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return this.get(id, connectionMode !== undefined);
  }
}
