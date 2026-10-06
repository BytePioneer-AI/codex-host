import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { object } from "./shared-thread-peer.js";
import { defaultMappingStoreDirectory } from "./external-thread-repository.js";

const keys = new Set(["model", "model_reasoning_effort", "service_tier"]);
export function modelPreferenceKey(key: unknown): key is string {
  return typeof key === "string" && keys.has(key);
}
function validate(values: unknown): JsonObject {
  if (
    !object(values) ||
    Object.entries(values).some(
      ([key, value]) =>
        !keys.has(key) || (value !== null && (typeof value !== "string" || value.length > 4096)),
    )
  )
    throw new Error("Invalid mobile Model preferences");
  return values;
}
export function mobilePreferencesVersion(values: JsonObject): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** One local shared owner supplies this store to all mobile fronts. Never writes native config. */
export class MobileModelPreferences {
  readonly file: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(environment: NodeJS.ProcessEnv) {
    this.file = path.join(
      path.dirname(defaultMappingStoreDirectory(environment)),
      "mobile-model-preferences-v1.json",
    );
  }
  async read(): Promise<JsonObject> {
    await this.#tail;
    return this.#read();
  }
  async #read(): Promise<JsonObject> {
    try {
      return validate(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  write(
    edits: JsonObject[],
    expectedVersion: JsonValue | undefined,
    nativeVersion: string | undefined,
  ): Promise<JsonObject> {
    const task = this.#tail.then(async () => {
      const previous = await this.#read();
      // Before the first mobile write the client only knows the native user-layer version.
      // Once preferences exist, require their own version to prevent stale overwrites.
      if (
        expectedVersion != null &&
        expectedVersion !== mobilePreferencesVersion(previous) &&
        (Object.keys(previous).length > 0 || expectedVersion !== nativeVersion)
      )
        throw new Error("Mobile Model configuration changed; reload before saving");
      const next = { ...previous };
      for (const edit of edits) {
        if (
          !modelPreferenceKey(edit.keyPath) ||
          !["replace", "upsert"].includes(String(edit.mergeStrategy))
        )
          throw new Error("Unsupported mobile Model preference edit");
        next[edit.keyPath] = edit.value ?? null;
      }
      validate(next);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      return {
        status: "ok",
        version: mobilePreferencesVersion(next),
        filePath: this.file,
        overriddenMetadata: null,
      };
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
