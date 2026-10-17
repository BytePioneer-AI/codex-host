import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  harnessDisplayEntriesSchema,
  type HarnessDisplaySettings,
  type HarnessDisplaySet,
} from "@codexhost/shared-contracts";

/** Shared across local Host processes. Complete snapshots use last successful write wins. */
export class HarnessDisplaySettingsStore {
  readonly #file: string;
  #watcher: FSWatcher | undefined;
  #fingerprint?: string;
  #listeners = new Set<() => void>();
  #tail: Promise<unknown> = Promise.resolve();
  get eventsAvailable(): boolean {
    return this.#watcher !== undefined;
  }
  async subscribe(listener: () => void): Promise<() => void> {
    if (!this.#watcher) {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      this.#watcher = watch(path.dirname(this.#file), { persistent: false }, (_event, name) => {
        if (name && name.toString() !== path.basename(this.#file)) return;
        this.#tail = this.#tail
          .then(() => this.get().then((snapshot) => this.#publish(snapshot)))
          .catch(() => {});
      });
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
      this.#fingerprint = JSON.stringify(await this.get());
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #publish(snapshot: HarnessDisplaySettings): void {
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot reject accepted writes. */
      }
    }
  }
  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#listeners.clear();
  }

  constructor(environment: NodeJS.ProcessEnv) {
    this.#file = path.join(
      environment.CODEXHOST_DATA_DIR
        ? path.resolve(environment.CODEXHOST_DATA_DIR)
        : path.join(os.homedir(), ".codexhost"),
      "harness-display-settings-v1.json",
    );
  }
  async get(): Promise<HarnessDisplaySettings> {
    try {
      return {
        entries: harnessDisplayEntriesSchema.parse(JSON.parse(await readFile(this.#file, "utf8"))),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: null };
      throw new Error("Could not read Harness display settings");
    }
  }
  async set(input: HarnessDisplaySet): Promise<HarnessDisplaySettings> {
    const entries = harnessDisplayEntriesSchema.parse(input.entries);
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600, flag: "wx" });
      if (input.initializeOnly) {
        // Atomic create-if-absent: migration must never overwrite a Web edit or
        // another Desktop's migration, even across independent Host processes.
        try {
          await link(temporary, this.#file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } else {
        await rename(temporary, this.#file);
      }
      const snapshot = await this.get();
      this.#publish(snapshot);
      return snapshot;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
