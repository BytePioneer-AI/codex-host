import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ExtensionBackendProcess } from "@codexhost/extension-backend";
import {
  discoverWebNativeExtensions,
  prepareWebNativeExtension,
  readDesktopExtensionIcon,
  readDesktopExtensionScreenshot,
  readWebNativeExtension,
  readWebNativeExtensionAsset,
  readWebNativeExtensionBackend,
  readWebNativeExtensionSettings,
  uninstallWebNativeExtension,
  webNativeExtensionDataDirectory,
  WebNativeExtensionInstallConflict,
  writeWebNativeExtensionSettings,
  type WebNativeExtensionInstallation,
} from "@codexhost/harness-plugin-files";
import {
  encodeWebExtensionResourcePath,
  extensionBackendTargets,
  jsonValueSchema,
  WEB_EXTENSION_ASSETS_PREFIX,
  WEB_EXTENSION_RPC_ERRORS as errors,
  webExtensionAssetBaseUrl,
  webNativeExtensionIdSchema,
  type JsonValue,
  type WebExtensionRuntimeEntry,
  type WebExtensionRuntimeSnapshot,
  type WebNativeExtensionListItem,
} from "@codexhost/shared-contracts";
import type { DataDir } from "./store.ts";
import { RpcError } from "./transport.ts";

const SELECTION = "web-native-extensions-enabled.json";
const EMPTY_SNAPSHOT: WebExtensionRuntimeSnapshot = { revision: randomUUID(), extensions: [] };

class SerialQueue {
  tail = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// Across Web instances in this process: at most one downloaded/unpacked ZIP in flight.
const preparations = new SerialQueue();

type Generation = {
  installation: WebNativeExtensionInstallation;
  entry: WebExtensionRuntimeEntry;
  uiReady: boolean;
  uiError?: string;
  backendState: WebNativeExtensionListItem["backendState"];
  process?: ExtensionBackendProcess;
  ready: Promise<void>;
};

export class WebNativeExtensions {
  readonly #management = new SerialQueue();
  readonly #preparing = new Set<Promise<void>>();
  readonly #settings = new Map<string, SerialQueue>();
  readonly #settingsRevisions = new Map<string, string>();
  readonly #active = new Map<string, Generation>();
  readonly #cancel = new AbortController();
  #enabled = new Set<string>();
  #snapshot: WebExtensionRuntimeSnapshot = { revision: randomUUID(), extensions: [] };
  #start: Promise<void> | undefined;
  #stop: Promise<void> | undefined;

  constructor(
    private readonly data: DataDir,
    private readonly permitted: boolean,
  ) {
    if (!permitted) return;
    const saved = data.readJson<unknown>(SELECTION, []);
    if (Array.isArray(saved))
      for (const id of saved)
        if (webNativeExtensionIdSchema.safeParse(id).success) this.#enabled.add(id);
  }

  get available(): boolean {
    return this.permitted && !this.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.#cancel.signal;
  }

  start(): Promise<void> {
    if (!this.available) return Promise.resolve();
    return (this.#start ??= this.#management.run(async () => {
      const { installations } = await discoverWebNativeExtensions(this.data.root);
      for (const installation of installations) this.#activate(installation);
    }));
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    this.#cancel.abort();
    const stopped = [...this.#active.keys()].map((id) => this.#retire(id));
    this.#stop = Promise.allSettled([
      ...stopped,
      this.#management.tail,
      ...this.#preparing,
      ...[...this.#settings.values()].map(({ tail }) => tail),
    ]).then(() => undefined);
    return this.#stop;
  }

  snapshot(admitted: boolean): WebExtensionRuntimeSnapshot {
    return admitted && this.available ? this.#snapshot : EMPTY_SNAPSHOT;
  }

  #publish(): void {
    const extensions = [...this.#active.values()]
      .filter(
        ({ uiReady, entry, installation }) =>
          uiReady && (installation.manifest.web !== undefined || entry.hasBackend),
      )
      .map(({ entry }) => entry)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (
      extensions.length !== this.#snapshot.extensions.length ||
      extensions.some((entry, index) => entry !== this.#snapshot.extensions[index])
    )
      this.#snapshot = { revision: randomUUID(), extensions };
  }

  async list(): Promise<WebNativeExtensionListItem[]> {
    const { installations, diagnostics } = await discoverWebNativeExtensions(this.data.root);
    const valid = await Promise.all(
      installations.map(async ({ directory, digest, manifest }) => {
        const { id, version, icon, screenshots } = manifest;
        const generation = this.#active.get(id);
        const backendState =
          generation?.backendState ??
          (extensionBackendTargets(manifest).includes("web") ? "inactive" : "none");
        const error =
          generation?.uiError ??
          (backendState === "failed" ? "Extension backend failed." : undefined);
        const asUrl = ({ mime, bytes }: { mime: string; bytes: Buffer }) =>
          `data:${mime};base64,${bytes.toString("base64")}`;
        const artwork = await Promise.all([
          icon && readDesktopExtensionIcon(directory, icon).then(asUrl),
          screenshots &&
            Promise.all(
              screenshots.map((file) =>
                readDesktopExtensionScreenshot(directory, file).then(asUrl),
              ),
            ),
        ]).then(
          ([iconDataUrl, screenshotDataUrls]) => ({
            ...(iconDataUrl ? { iconDataUrl } : {}),
            ...(screenshotDataUrls ? { screenshotDataUrls } : {}),
          }),
          () => ({}),
        );
        return {
          format: "codexhost" as const,
          id,
          version,
          digest,
          manifest,
          enabled: this.#enabled.has(id),
          backendState,
          ...(error ? { error } : {}),
          ...artwork,
        };
      }),
    );
    return [
      ...valid,
      ...diagnostics.map(({ id }): WebNativeExtensionListItem => ({
        format: "codexhost",
        id,
        enabled: this.#enabled.has(id),
        backendState: "inactive",
        error: "The installed extension package is invalid or missing files.",
      })),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }

  changePackage(
    source: () => Promise<
      Pick<Parameters<typeof prepareWebNativeExtension>[0], "zipBuffer" | "expected">
    >,
    update?: { id: string; expectedDigest: string },
  ): Promise<void> {
    const task = preparations.run(async () => {
      this.#requireAvailable();
      const input = await source();
      this.#requireAvailable();
      const prepared = await prepareWebNativeExtension({ ...input, dataDir: this.data.root });
      try {
        const id = prepared.manifest.id;
        if (update && update.id !== id)
          throw new RpcError(errors.invalidParams, "An update must retain the extension ID.");
        await this.#management.run(async () => {
          this.#requireAvailable();
          const current = update && (await readWebNativeExtension(this.#location(id)));
          if (update && (!current || current.digest !== update.expectedDigest))
            throw new RpcError(errors.stale, "The installed package has changed.");
          if (current) await this.#retire(id);
          try {
            this.#requireAvailable();
            // A fresh package never inherits a selection left by a missing package.
            if (
              !update &&
              this.#enabled.has(id) &&
              !(await readWebNativeExtension(this.#location(id)))
            )
              this.#select(id, false);
            const installed = await prepared.commit(update?.expectedDigest ?? null);
            this.#activate(installed);
          } catch (error) {
            if (current) this.#activate(current);
            if (error instanceof WebNativeExtensionInstallConflict)
              throw new RpcError(errors.stale, "The installed package has changed.");
            throw error;
          }
        });
      } finally {
        await prepared.dispose();
      }
    });
    this.#preparing.add(task);
    return task.finally(() => this.#preparing.delete(task));
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.#management.run(async () => {
      this.#requireAvailable();
      const installation = await this.#installed(id, !enabled);
      this.#requireAvailable();
      if (enabled) {
        this.#select(id, true);
        if (installation) this.#activate(installation);
      } else {
        const stopped = this.#retire(id);
        try {
          this.#select(id, false);
        } finally {
          await stopped;
        }
      }
    });
  }

  uninstall(id: string): Promise<void> {
    return this.#management.run(async () => {
      this.#requireAvailable();
      await this.#installed(id, true);
      await this.#retire(id);
      this.#requireAvailable();
      this.#select(id, false);
      if (!(await uninstallWebNativeExtension(this.#location(id)))) throw this.#notFound();
      this.#settingsRevisions.delete(id);
    });
  }

  async #installed(id: string, allowBroken = false) {
    try {
      const installation = await readWebNativeExtension(this.#location(id));
      if (installation) return installation;
    } catch (error) {
      if (allowBroken) return;
      throw error;
    }
    throw this.#notFound();
  }

  #select(id: string, enabled: boolean) {
    if (this.#enabled.has(id) === enabled) return;
    const next = new Set(this.#enabled);
    if (enabled) next.add(id);
    else next.delete(id);
    this.data.writeJson(SELECTION, [...next], { mode: 0o600 });
    this.#enabled = next;
  }

  #activate(installation: WebNativeExtensionInstallation): void {
    const {
      digest,
      manifest: { id, version, web, settingsSchema },
    } = installation;
    if (!this.available || !this.#enabled.has(id) || this.#active.has(id)) return;
    const activationId = randomUUID();
    const assetBaseUrl = webExtensionAssetBaseUrl({ id, activationId, digest });
    const generation: Generation = {
      installation,
      entry: {
        id,
        version,
        digest,
        activationId,
        assetBaseUrl,
        ...(web?.entry
          ? { entryUrl: assetBaseUrl + encodeWebExtensionResourcePath(web.entry) }
          : {}),
        ...(web?.style
          ? { styleUrl: assetBaseUrl + encodeWebExtensionResourcePath(web.style) }
          : {}),
        ...(settingsSchema ? { settingsSchema } : {}),
        settingsRevision: this.#settingsRevision(id),
        hasBackend: false,
      },
      uiReady: false,
      backendState: extensionBackendTargets(installation.manifest).includes("web")
        ? "starting"
        : "none",
      ready: Promise.resolve(),
    };
    this.#active.set(id, generation);
    generation.ready = Promise.all([
      this.#checkUi(generation),
      ...(generation.backendState === "starting" ? [this.#startBackend(generation)] : []),
    ]).then(() => undefined);
  }

  async #checkUi(generation: Generation) {
    const {
      installation,
      entry: { id },
    } = generation;
    try {
      await Promise.all(
        [installation.manifest.web?.entry, installation.manifest.web?.style]
          .filter((file) => file !== undefined)
          .map((file) => readWebNativeExtensionAsset(installation, file)),
      );
      generation.uiReady = true;
    } catch {
      generation.uiError = "Extension UI resources are unavailable.";
    }
    if (this.#active.get(id) === generation) this.#publish();
  }

  async #startBackend(generation: Generation) {
    const {
      installation,
      entry: { id, activationId },
    } = generation;
    const live = () => this.#active.get(id) === generation;
    const failed = () => {
      if (!live()) return;
      generation.backendState = "failed";
      if (generation.entry.hasBackend) {
        generation.entry = { ...generation.entry, hasBackend: false };
        this.#publish();
      }
    };
    const admit = () => {
      if (!live() || generation.backendState === "failed") throw this.#inactive();
    };
    try {
      const backend = await readWebNativeExtensionBackend(installation);
      if (!backend || !live()) return;
      const dataDir = await webNativeExtensionDataDirectory(this.#location(id), true);
      if (!live()) return;
      const child = new ExtensionBackendProcess({
        readSettings: async () => (await this.readSettings(id, activationId, admit)).values,
        writeSettings: async (values) =>
          (await this.writeSettings(id, activationId, values, admit)).values,
        diagnose: failed,
      });
      generation.process = child;
      await child.activate({
        extensionId: id,
        extensionDir: backend.directory,
        dataDir,
        url: pathToFileURL(backend.scriptPath).href,
        hash: backend.hash,
        installation: backend.installation,
      });
      if (!live() || generation.backendState === "failed") return;
      generation.backendState = "running";
      generation.entry = { ...generation.entry, hasBackend: true };
      this.#publish();
    } catch {
      failed();
      if (live()) await generation.process?.terminate();
    }
  }

  async #retire(id: string): Promise<void> {
    const generation = this.#active.get(id);
    if (!generation) return;
    this.#active.delete(id);
    this.#publish();
    // Drain admitted writes, then release the child without holding the settings lock.
    await this.#settings.get(id)?.tail;
    await generation.process?.stop().catch(() => undefined); // stop() reaps even if dispose throws.
    await generation.ready;
  }

  async asset(path: string) {
    if (!this.available) return;
    const id = path.slice(WEB_EXTENSION_ASSETS_PREFIX.length).split("/", 1)[0];
    const generation = id && this.#active.get(id);
    if (!generation || !generation.uiReady || !path.startsWith(generation.entry.assetBaseUrl))
      return;
    const relative = path.slice(generation.entry.assetBaseUrl.length);
    try {
      const resource = decodeURIComponent(relative);
      if (encodeWebExtensionResourcePath(resource) !== relative) return;
      const asset = await readWebNativeExtensionAsset(generation.installation, resource);
      if (this.#active.get(id) === generation) return asset;
    } catch {
      // Invalid, private and missing resources are indistinguishable to the client.
    }
  }

  async invoke(id: string, activationId: string, method: string, params: JsonValue | undefined) {
    const generation = this.#generation(id, activationId);
    if (!generation.entry.hasBackend || !generation.process) throw this.#inactive();
    try {
      const result = jsonValueSchema.parse(await generation.process.invoke(method, params ?? null));
      this.#generation(id, activationId);
      return { result };
    } catch {
      this.#generation(id, activationId);
      throw new RpcError(errors.backendFailed, "Extension backend call failed.");
    }
  }

  readSettings(id: string, activationId?: string, admit?: () => void) {
    return this.#withSettings(id, activationId, admit, async () => ({
      values: await readWebNativeExtensionSettings(this.#location(id)),
      revision: this.#settingsRevision(id),
    }));
  }

  writeSettings(id: string, activationId: string | undefined, input: unknown, admit?: () => void) {
    return this.#withSettings(id, activationId, admit, async () => {
      const values = await writeWebNativeExtensionSettings({
        ...this.#location(id),
        values: input,
      });
      const revision = randomUUID();
      this.#settingsRevisions.set(id, revision);
      const generation = this.#active.get(id);
      if (generation) {
        generation.entry = { ...generation.entry, settingsRevision: revision };
        this.#publish();
      }
      return { values, revision };
    });
  }

  #withSettings<T>(
    id: string,
    activationId: string | undefined,
    admit: (() => void) | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    const queue = this.#settings.get(id) ?? new SerialQueue();
    this.#settings.set(id, queue);
    const result = queue.run(async () => {
      this.#requireAvailable();
      admit?.();
      if (activationId === undefined) await this.#installed(id);
      else this.#generation(id, activationId);
      this.#requireAvailable();
      return op();
    });
    const tail = queue.tail;
    return result.finally(() => {
      if (queue.tail === tail) this.#settings.delete(id);
    });
  }

  #settingsRevision(id: string): string {
    const revision = this.#settingsRevisions.get(id) ?? randomUUID();
    this.#settingsRevisions.set(id, revision);
    return revision;
  }

  #generation(id: string, activationId: string): Generation {
    const generation = this.#active.get(id);
    if (!this.available || generation?.entry.activationId !== activationId) throw this.#inactive();
    return generation;
  }

  #location(id: string) {
    return { dataDir: this.data.root, id };
  }

  #requireAvailable(): void {
    if (!this.available) throw this.#inactive();
  }

  #inactive() {
    return new RpcError(errors.inactive, "Extension generation is not active.");
  }

  #notFound() {
    return new RpcError(errors.notFound, "Extension is not installed.");
  }
}
