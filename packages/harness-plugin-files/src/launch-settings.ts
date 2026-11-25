import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  harnessLaunchPathSchema,
  harnessPluginIdSchema,
  type HarnessLaunchSettings,
} from "@codexhost/shared-contracts";

/** The value captured for an Adapter, or why the file could not be read at that moment. */
type InitialSnapshot = { readonly path: string | null } | { readonly error: Error };

/** Per-plugin files avoid lost updates between independently running Host connections. */
export class HarnessLaunchSettingsStore {
  readonly #directory: string;
  readonly #initial = new Map<string, Promise<InitialSnapshot>>();

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
    const file = this.#file(id);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw new Error(`Could not read Harness launch settings at ${file}`, { cause: error });
    }
    let parsed: string | undefined;
    try {
      parsed = harnessLaunchPathSchema.parse(JSON.parse(text));
    } catch {
      // Reported below with the file path.
    }
    if (parsed === undefined || !path.isAbsolute(parsed)) {
      throw new Error(
        `Could not read Harness launch settings at ${file}: expected an absolute installation path; save a new path or reset it`,
      );
    }
    return parsed;
  }

  #snapshot(id: string): Promise<InitialSnapshot> {
    let initial = this.#initial.get(id);
    if (!initial) {
      initial = this.#read(id).then(
        (value) => ({ path: value }),
        (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
      this.#initial.set(id, initial);
    }
    return initial;
  }

  /**
   * Capture the value used to construct this Host's Adapter; changes require a restart. A failed
   * read is remembered for restart reporting but not reused: the next call reads the file again.
   */
  async initialCommand(id: string): Promise<string | undefined> {
    const cached = this.#initial.get(id);
    if (cached && "error" in (await cached)) this.#initial.delete(id);
    const snapshot = await this.#snapshot(id);
    if ("error" in snapshot) throw snapshot.error;
    return snapshot.path ?? undefined;
  }

  /** The Adapter was built without a readable setting, so any saved value needs a restart. */
  #restartRequired(snapshot: InitialSnapshot, value: string | null): boolean {
    return "error" in snapshot || value !== snapshot.path;
  }

  async get(id: string): Promise<HarnessLaunchSettings> {
    const snapshot = await this.#snapshot(id);
    const value = await this.#read(id);
    return { path: value, restartRequired: this.#restartRequired(snapshot, value) };
  }

  /** Replaces the file without reading it, so an unreadable file can always be repaired. */
  async set(id: string, value: string | null): Promise<HarnessLaunchSettings> {
    const snapshot = await this.#snapshot(id);
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
    return { path: value, restartRequired: this.#restartRequired(snapshot, value) };
  }
}
