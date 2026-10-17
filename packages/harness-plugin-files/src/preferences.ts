/** Durable preferences. The runtime owner serializes mutations; browsers never write this file. */
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  harnessPreferencePatchSchema,
  harnessPreferenceScopeSchema,
  harnessPreferencesDocumentSchema,
  type HarnessPreferencePatch,
  type HarnessPreferenceScope,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";

type Document = ReturnType<typeof harnessPreferencesDocumentSchema.parse>;
export class HarnessPreferenceConflict extends Error {}

export class HarnessPreferencesStore {
  readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private watching: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private fingerprint: string | undefined;
  private listeners = new Set<(revision: number) => void>();
  private closed = false;
  constructor(private readonly directory: string) {
    this.file = join(directory, "harness-preferences-v1.json");
  }

  private async read(): Promise<Document> {
    try {
      return harnessPreferencesDocumentSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, revision: 0, scopes: {} };
      throw new Error("Could not read Harness preferences");
    }
  }
  async get(scope: HarnessPreferenceScope = "external"): Promise<HarnessPreferenceSnapshot> {
    harnessPreferenceScopeSchema.parse(scope);
    const document = await this.read();
    return {
      scope,
      revision: document.revision,
      values: structuredClone(document.scopes[scope] ?? { favorites: {} }),
    };
  }
  patch(input: HarnessPreferencePatch): Promise<HarnessPreferenceSnapshot> {
    const request = harnessPreferencePatchSchema.parse(input);
    const work = this.tail.then(async () => {
      if (this.closed) throw new Error("Harness preferences store is closed");
      const document = await this.read();
      if (request.expectedRevision !== undefined && request.expectedRevision !== document.revision)
        throw new HarnessPreferenceConflict("Harness preferences changed; refresh before editing");
      const before = JSON.stringify(document.scopes);
      const values = document.scopes[request.scope] ?? { favorites: {} };
      for (const operation of request.operations) {
        if (operation.kind === "idleRelease") {
          if (!request.initializeOnly || values.idleRelease === undefined)
            values.idleRelease = operation.value;
        } else if (operation.kind === "favorites") {
          if (!request.initializeOnly || values.favorites[operation.harnessId] === undefined)
            values.favorites[operation.harnessId] = [...new Set(operation.modelIds)];
        } else if (operation.kind === "favorite") {
          const favorites = new Set(values.favorites[operation.harnessId] ?? []);
          if (operation.enabled) favorites.add(operation.modelId);
          else favorites.delete(operation.modelId);
          values.favorites[operation.harnessId] = [...favorites];
        } else {
          const defaults = values.newThread ?? { byHarness: {} };
          if (
            operation.lastHarness &&
            (!request.initializeOnly || defaults.lastHarness === undefined)
          )
            defaults.lastHarness = operation.lastHarness;
          if (
            operation.harnessId &&
            operation.configuration &&
            (!request.initializeOnly || defaults.byHarness[operation.harnessId] === undefined)
          )
            defaults.byHarness[operation.harnessId] = operation.configuration;
          values.newThread = defaults;
        }
      }
      document.scopes[request.scope] = values;
      if (before !== JSON.stringify(document.scopes)) {
        document.revision++;
        harnessPreferencesDocumentSchema.parse(document);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(document) + "\n", { flag: "wx", mode: 0o600 });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.publish(document);
      }
      return { scope: request.scope, revision: document.revision, values: structuredClone(values) };
    });
    this.tail = work.catch(() => {});
    return work;
  }
  private publish(document: Document) {
    const fingerprint = JSON.stringify(document);
    if (this.closed || this.fingerprint === fingerprint) return;
    this.fingerprint = fingerprint;
    for (const listener of this.listeners) {
      try {
        listener(document.revision);
      } catch {
        /* Observers cannot reject an accepted write. */
      }
    }
  }
  async subscribe(listener: (revision: number) => void): Promise<() => void> {
    if (this.closed) throw new Error("Harness preferences store is closed");
    this.listeners.add(listener);
    if (!this.watching)
      this.watching = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (this.closed) return;
        this.fingerprint = JSON.stringify(await this.read());
        if (this.closed) return;
        const refresh = () => {
          void this.read()
            .then((document) => this.publish(document))
            .catch(() => {});
        };
        this.watcher = watch(this.directory, { persistent: false }, (_event, name) => {
          if (name && name.toString() !== "harness-preferences-v1.json") return;
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(refresh, 30);
          this.refreshTimer.unref();
        });
        this.watcher.on("error", () => {});
      })();
    try {
      await this.watching;
    } catch (error) {
      this.listeners.delete(listener);
      this.watching = undefined;
      throw error;
    }
    return () => this.listeners.delete(listener);
  }
  async close() {
    this.closed = true;
    this.watcher?.close();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.listeners.clear();
    await this.tail;
  }
}
