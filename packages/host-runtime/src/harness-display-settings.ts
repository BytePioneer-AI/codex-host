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
      return await this.get();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
