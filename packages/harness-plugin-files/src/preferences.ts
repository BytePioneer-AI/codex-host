/** Durable preferences. The runtime owner serializes mutations; browsers never write this file. */
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  harnessPreferencePatchSchema,
  harnessPreferenceScopeSchema,
  harnessPreferencesDocumentSchema,
  type HarnessPreferencePatch,
  type HarnessPreferenceScope,
  type HarnessPreferenceSnapshot,
  type HarnessPreferenceValues,
} from "@codexhost/shared-contracts";
import { renameWithWindowsRetry } from "./rename-with-windows-retry.js";

type Document = ReturnType<typeof harnessPreferencesDocumentSchema.parse>;
type MigrateModels = (values: HarnessPreferenceValues, migrated: Set<string>) => Promise<void>;
// Older stores already carry unowned scopes through writes verbatim.
const MODEL_REF_MIGRATION = "model-ref-migration-v1";
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

  private async read(): Promise<{ document: Document; retained: Record<string, unknown> }> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      const scopes =
        typeof raw === "object" && raw !== null && "scopes" in raw ? raw.scopes : undefined;
      const owned: Record<string, unknown> = {};
      const retained: Record<string, unknown> = {};
      if (typeof scopes === "object" && scopes !== null && !Array.isArray(scopes))
        for (const [scope, values] of Object.entries(scopes))
          (harnessPreferenceScopeSchema.safeParse(scope).success ? owned : retained)[scope] =
            values;
      const document = harnessPreferencesDocumentSchema.parse({
        ...(raw as object),
        ...(scopes === undefined ? {} : { scopes: owned }),
      });
      return { document, retained };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { document: { version: 1, revision: 0, scopes: {} }, retained: {} };
      throw new Error("Could not read Harness preferences");
    }
  }
  async get(
    scope: HarnessPreferenceScope = "external",
    migrateModels?: MigrateModels,
  ): Promise<HarnessPreferenceSnapshot> {
    harnessPreferenceScopeSchema.parse(scope);
    if (migrateModels) return this.update(scope, migrateModels);
    const { document } = await this.read();
    return {
      scope,
      revision: document.revision,
      values: structuredClone(document.scopes[scope] ?? { favorites: {} }),
    };
  }
  patch(
    input: HarnessPreferencePatch,
    migrateModels?: MigrateModels,
  ): Promise<HarnessPreferenceSnapshot> {
    const request = harnessPreferencePatchSchema.parse(input);
    return this.update(
      request.scope,
      async (values, migrated) => {
        // Edit canonical favorites; legacy initialize-only imports are migrated after insertion.
        if (!request.initializeOnly) await migrateModels?.(values, migrated);
        const importModel = (id: string) => {
          if (request.initializeOnly) migrated.delete(id);
        };
        for (const operation of request.operations) {
          if (operation.kind === "idleRelease") {
            if (!request.initializeOnly || values.idleRelease === undefined)
              values.idleRelease = operation.value;
          } else if (operation.kind === "favorites") {
            if (!request.initializeOnly || values.favorites[operation.harnessId] === undefined) {
              values.favorites[operation.harnessId] = [...new Set(operation.modelIds)];
              if (operation.modelIds.length) importModel(operation.harnessId);
            }
          } else if (operation.kind === "favorite") {
            const favorites = new Set(values.favorites[operation.harnessId] ?? []);
            if (operation.enabled) favorites.add(operation.modelId);
            else favorites.delete(operation.modelId);
            values.favorites[operation.harnessId] = [...favorites];
          } else if (operation.kind === "delegation") {
            const { harnessId, configuration } = operation;
            const byHarness = values.delegation?.byHarness ?? {};
            const exists = Object.hasOwn(byHarness, harnessId);
            if (request.initializeOnly && exists) continue;
            if (configuration === null) {
              if (!exists) continue;
              const remaining = Object.fromEntries(
                Object.entries(byHarness).filter(([id]) => id !== harnessId),
              );
              if (Object.keys(remaining).length === 0) delete values.delegation;
              else values.delegation = { byHarness: remaining };
            } else {
              values.delegation = { byHarness: { ...byHarness, [harnessId]: configuration } };
              if (configuration.model) importModel(harnessId);
            }
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
            ) {
              defaults.byHarness[operation.harnessId] = operation.configuration;
              if (operation.configuration.model) importModel(operation.harnessId);
            }
            values.newThread = defaults;
          }
        }
        if (request.initializeOnly) await migrateModels?.(values, migrated);
      },
      request.expectedRevision,
    );
  }
  private update(
    scope: HarnessPreferenceScope,
    mutate: MigrateModels,
    expectedRevision?: number,
  ): Promise<HarnessPreferenceSnapshot> {
    const work = this.tail.then(async () => {
      if (this.closed) throw new Error("Harness preferences store is closed");
      const { document, retained } = await this.read();
      if (expectedRevision !== undefined && expectedRevision !== document.revision)
        throw new HarnessPreferenceConflict("Harness preferences changed; refresh before editing");
      const values = document.scopes[scope] ?? { favorites: {} };
      const before = structuredClone(values);
      const marker = retained[MODEL_REF_MIGRATION];
      const previous = new Set<string>(
        Array.isArray(marker) ? marker.filter((id): id is string => typeof id === "string") : [],
      );
      const migrated = new Set(previous);
      await mutate(values, migrated);
      const changed = !isDeepStrictEqual(before, values);
      const markerChanged = !isDeepStrictEqual(previous, migrated);
      if (changed) {
        document.scopes[scope] = values;
        document.revision++;
        harnessPreferencesDocumentSchema.parse(document);
      }
      if (markerChanged) retained[MODEL_REF_MIGRATION] = [...migrated];
      if (changed || markerChanged) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          const persisted = { ...document, scopes: { ...retained, ...document.scopes } };
          await writeFile(temporary, JSON.stringify(persisted) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          await renameWithWindowsRetry(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        if (changed) this.publish(document);
      }
      return { scope, revision: document.revision, values: structuredClone(values) };
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
        this.fingerprint = JSON.stringify((await this.read()).document);
        if (this.closed) return;
        const refresh = () => {
          void this.read()
            .then(({ document }) => this.publish(document))
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
