import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  harnessLaunchPathSchema,
  harnessPluginIdSchema,
  type HarnessLaunchSettings,
} from "@codexhost/shared-contracts";

/** Per-plugin files avoid lost updates between independently running Host connections. */
export class HarnessLaunchSettingsStore {
  readonly #directory: string;
  readonly #initial = new Map<string, Promise<string | null>>();

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

  async #read(id: string): Promise<string | null> {
    try {
      const value = harnessLaunchPathSchema.parse(
        JSON.parse(await readFile(this.#file(id), "utf8")),
      );
      if (!path.isAbsolute(value)) throw new Error("Expected an absolute entrypoint path");
      return value;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw new Error("Could not read Harness launch settings");
    }
  }

  /** Capture the value used to construct this Host's Adapter; changes require a restart. */
  async initialCommand(id: string): Promise<string | undefined> {
    let initial = this.#initial.get(id);
    if (!initial) {
      initial = this.#read(id);
      this.#initial.set(id, initial);
    }
    return (await initial) ?? undefined;
  }

  async get(id: string): Promise<HarnessLaunchSettings> {
    const initial = (await this.initialCommand(id)) ?? null;
    const value = await this.#read(id);
    return { path: value, restartRequired: value !== initial };
  }

  async set(id: string, value: string | null): Promise<HarnessLaunchSettings> {
    const initial = (await this.initialCommand(id)) ?? null;
    const file = this.#file(id);
    if (value === null) {
      await rm(file, { force: true });
    } else {
      value = harnessLaunchPathSchema.parse(value);
      if (!path.isAbsolute(value))
        throw new Error("Use an absolute entrypoint path without arguments");
      const metadata = await stat(value).catch(() => undefined);
      if (!metadata?.isDirectory() && !metadata?.isFile())
        throw new Error("The installation path must be an existing directory on this Host");
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { path: value, restartRequired: value !== initial };
  }
}
