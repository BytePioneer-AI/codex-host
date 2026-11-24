import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ExtensionBackendProcess } from "@codexhost/extension-backend";
import {
  discoverHostExtensions,
  fetchHostExtensionCatalog,
  hostExtensionDataDirectory,
  HostExtensionInstallConflict,
  HostExtensionRevisionConflict,
  migrateLegacyDesktopExtensionsOnce,
  prepareHostExtension,
  readHostExtension,
  readHostExtensionAsset,
  readHostExtensionBackend,
  readHostExtensionConfiguration,
  readHostExtensionSettings,
  reportHostExtensionInstall,
  resolveHostExtensionStatsUrl,
  rollbackHostExtension,
  uninstallHostExtension,
  updateHostExtensionConfiguration,
  writeHostExtensionSettings,
  type HostExtensionDiskInstallation,
} from "@codexhost/harness-plugin-files";
import {
  jsonObjectSchema,
  type HostExtensionListItem,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
  type HOST_EXTENSIONS_RPC as RPC,
} from "@codexhost/shared-contracts";
import { errorMessage } from "./desktop-rpc.js";

type Valid = Extract<HostExtensionListItem, { state: "valid" }>;
type Instance = {
  activationId: string;
  state: "starting" | "running" | "failed";
  process?: ExtensionBackendProcess;
  error?: string;
};

/** One owner for every unified install, regardless of attached frontend sessions. */
export class HostExtensionManager {
  readonly #instances = new Map<string, Instance>();
  #queue = Promise.resolve();
  // Backend activation/disposal can wait for settings IPC. Do not make IPC wait
  // on the lifecycle queue (or hold the lifecycle queue while invoking handlers).
  #settingsQueue = Promise.resolve();
  #startup: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #revision = 0;

  constructor(
    private readonly dataDir: string,
    private readonly changed: (revision: number) => void,
    private readonly diagnose: (message: string) => void = () => undefined,
  ) {}

  start(): Promise<void> {
    if (this.#closing) return this.#closing;
    return (this.#startup ??= this.#serialize(async () => {
      await migrateLegacyDesktopExtensionsOnce(this.dataDir, this.diagnose).catch(
        (error: unknown) =>
          this.diagnose(`Legacy Desktop extension migration: ${errorMessage(error)}`),
      );
      const { installations, configuration } = await discoverHostExtensions(this.dataDir);
      await Promise.all(
        installations
          .filter(({ id }) => configuration.enabled.includes(id))
          .map((entry) => this.#startBackend(entry)),
      );
    }).catch((error: unknown) => this.diagnose(`Host extensions: ${errorMessage(error)}`)));
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#serialize(() => this.#stopAll()));
  }

  list(): Promise<HostExtensionsRpcResult<typeof RPC.list>> {
    return this.#run(async () => {
      const { extensions, configuration, diagnostics } = await discoverHostExtensions(this.dataDir);
      return {
        revision: this.#revision,
        configuration,
        diagnostics,
        extensions: extensions.map((entry): HostExtensionListItem => {
          if (entry.state !== "valid") return entry;
          const instance = this.#instances.get(entry.id);
          const current = instance?.activationId === entry.activationId ? instance : undefined;
          return {
            ...entry,
            backendState: !entry.manifest.backend ? "none" : (current?.state ?? "inactive"),
            ...(current?.error ? { backendError: current.error } : {}),
          };
        }),
      };
    });
  }

  snapshot(): Promise<HostExtensionsRpcResult<typeof RPC.snapshot>> {
    return this.#run(async () => {
      const { extensions } = await discoverHostExtensions(this.dataDir);
      const active = extensions.filter(
        (entry): entry is Valid => entry.state === "valid" && entry.enabled,
      );
      return this.#withSettings(async () => {
        const entries = await Promise.all(
          active.map(
            async ({
              id,
              activationId,
              digest,
              manifest,
              installedAt,
              source,
              desktopConflictWith,
            }) => {
              const { settingsRevision } = await readHostExtensionSettings({
                dataDir: this.dataDir,
                id,
                activationId,
              }).catch((error: unknown) => {
                this.diagnose(`Host extension settings (${id}): ${errorMessage(error)}`);
                return { settingsRevision: 0 };
              });
              return {
                id,
                activationId,
                digest,
                manifest,
                installedAt,
                ...(source ? { source } : {}),
                ...(desktopConflictWith ? { desktopConflictWith } : {}),
                settingsRevision,
              };
            },
          ),
        );
        return { revision: this.#revision, extensions: entries };
      });
    });
  }

  catalog(input: HostExtensionsRpcParams<typeof RPC.catalog>) {
    return fetchHostExtensionCatalog(input);
  }

  install({ source }: HostExtensionsRpcParams<typeof RPC.install>) {
    return this.#run(async () => {
      const installed = await (
        await prepareHostExtension({ dataDir: this.dataDir, source })
      ).commit({ expectedDigest: null });
      // An enabled ID can survive a damaged/missing install; honor the selection.
      try {
        if ((await readHostExtensionConfiguration(this.dataDir)).enabled.includes(installed.id))
          await this.#startBackend(installed);
      } finally {
        this.#publish();
      }
      if (source.type === "catalog")
        void reportHostExtensionInstall(installed.id, resolveHostExtensionStatsUrl());
      return installed;
    });
  }

  update(input: HostExtensionsRpcParams<typeof RPC.update>) {
    return this.#run(async () => {
      const { id, expectedDigest, expectedActivationId } = input;
      const location = { dataDir: this.dataDir, id };
      const previous = await readHostExtension(location);
      if (
        previous?.digest !== expectedDigest ||
        (expectedActivationId !== undefined && previous.activationId !== expectedActivationId)
      )
        throw new HostExtensionInstallConflict("Extension activation changed");
      const provenance = previous.source;
      const source =
        input.source ??
        (provenance?.type === "catalog" || provenance?.type === "github" ? provenance : undefined);
      if (!source) throw new Error("An update source is required for this installation");
      const staged = await prepareHostExtension({
        ...location,
        source,
        expected: { id },
        forceRefreshCatalog: true,
      });
      try {
        const enabled = (await readHostExtensionConfiguration(this.dataDir)).enabled.includes(id);
        this.#assertOpen();
        await this.#stop(id);
        let installed: Awaited<ReturnType<typeof staged.commit>> | undefined;
        try {
          installed = await staged.commit({
            expectedDigest,
            expectedActivationId: previous.activationId,
          });
          if (enabled && !(await this.#startBackend(installed)))
            throw new Error("Updated extension backend could not start");
        } catch (error) {
          await this.#stop(id);
          try {
            const restored = installed
              ? await rollbackHostExtension({
                  ...location,
                  previous,
                  expectedActivationId: installed.activationId,
                })
              : await readHostExtension(location);
            if (enabled && restored) await this.#startBackend(restored);
          } finally {
            if (installed) this.#publish();
          }
          throw error;
        }
        this.#publish();
        if (source.type === "catalog")
          void reportHostExtensionInstall(installed.id, resolveHostExtensionStatsUrl());
        return installed;
      } finally {
        await staged.dispose();
      }
    });
  }

  select(
    change:
      | { action: "enable" | "disable"; id: string; expectedRevision: number }
      | { action: "disableAll"; expectedRevision?: number | undefined },
  ): Promise<HostExtensionsRpcResult<typeof RPC.enable>> {
    return this.#run(async () => {
      const enabledEntry =
        change.action === "enable"
          ? (await discoverHostExtensions(this.dataDir)).installations.find(
              ({ id }) => id === change.id,
            )
          : undefined;
      try {
        if (change.action === "enable" && !enabledEntry)
          throw new Error("Extension is not installed or is invalid");
        const configuration = await updateHostExtensionConfiguration(this.dataDir, change);
        if (change.action === "disableAll") await this.#stopAll();
        else if (change.action === "disable") await this.#stop(change.id);
        else if (enabledEntry) {
          if (this.#instances.get(change.id)?.state === "failed") await this.#stop(change.id);
          await this.#startBackend(enabledEntry);
        }
        this.#publish();
        return { state: "saved", configuration };
      } catch (error) {
        if (error instanceof HostExtensionRevisionConflict)
          return { state: "revision-conflict", revision: error.revision };
        throw error;
      }
    });
  }

  uninstall(input: HostExtensionsRpcParams<typeof RPC.uninstall>) {
    return this.#run(async () => {
      const { id, expectedDigest } = input;
      if (
        expectedDigest !== undefined &&
        (await readHostExtension({ dataDir: this.dataDir, id }))?.digest !== expectedDigest
      )
        throw new HostExtensionInstallConflict("Extension activation changed");
      await this.#stop(id);
      try {
        return { id, removed: await uninstallHostExtension({ dataDir: this.dataDir, ...input }) };
      } catch (error) {
        const { installations, configuration } = await discoverHostExtensions(this.dataDir);
        const installed = installations.find((entry) => entry.id === id);
        if (installed && configuration.enabled.includes(id)) await this.#startBackend(installed);
        throw error;
      } finally {
        this.#publish();
      }
    });
  }

  asset(input: HostExtensionsRpcParams<typeof RPC.asset>) {
    return this.#run(async () => {
      const { extensions } = await discoverHostExtensions(this.dataDir);
      const entry = extensions.find(({ id }) => id === input.id);
      if (
        entry?.state !== "valid" ||
        (!entry.enabled &&
          input.path !== entry.manifest.icon &&
          !entry.manifest.screenshots?.includes(input.path))
      )
        throw new Error("Extension asset is not available");
      return readHostExtensionAsset({
        dataDir: this.dataDir,
        activationId: entry.activationId,
        digest: entry.digest,
        ...input,
      });
    });
  }

  settingsGet(input: HostExtensionsRpcParams<typeof RPC.settingsGet>) {
    return this.#run(async () => readHostExtensionSettings(await this.#location(input)));
  }

  settingsSet(input: HostExtensionsRpcParams<typeof RPC.settingsSet>) {
    return this.#run(() => this.#saveSettings({ dataDir: this.dataDir, ...input }));
  }

  async invoke(input: HostExtensionsRpcParams<typeof RPC.backendInvoke>) {
    const { pending } = await this.#run(async () => {
      const location = await this.#location(input);
      const instance = this.#instances.get(input.id);
      if (
        instance?.activationId !== location.activationId ||
        instance.state !== "running" ||
        !instance.process ||
        !(await readHostExtensionConfiguration(this.dataDir)).enabled.includes(input.id)
      )
        throw new Error("Extension backend is not active");
      return { pending: instance.process.invoke(input.method, input.params) };
    });
    return pending;
  }

  async #location({ id, activationId }: HostExtensionsRpcParams<typeof RPC.settingsGet>) {
    const location = { dataDir: this.dataDir, id };
    const entry = await readHostExtension(location);
    if (!entry) throw new Error("Extension is not installed");
    if (activationId !== undefined && activationId !== entry.activationId)
      throw new HostExtensionInstallConflict("Extension activation changed");
    return { ...location, activationId: entry.activationId };
  }

  async #startBackend({
    id,
    activationId,
    digest,
    manifest,
  }: HostExtensionDiskInstallation): Promise<boolean> {
    if (!manifest.backend || this.#closing) return true;
    const existing = this.#instances.get(id);
    if (existing) return existing.state === "running" && existing.activationId === activationId;
    const instance: Instance = { activationId, state: "starting" };
    this.#instances.set(id, instance);
    const location = { dataDir: this.dataDir, id, activationId };
    const assertCurrent = () => {
      if (this.#instances.get(id) !== instance || instance.state === "failed")
        throw new Error("Extension backend is not active");
    };
    const fail = (message: string) => {
      if (this.#instances.get(id) !== instance) return;
      const wasRunning = instance.state === "running";
      instance.state = "failed";
      instance.error = "Extension backend stopped or could not start";
      this.diagnose(`Host extension backend (${id}): ${message}`);
      if (wasRunning) this.#publish();
    };
    try {
      const entry = await readHostExtensionBackend({ ...location, digest });
      if (!entry) throw new Error("Missing backend entry");
      const dataDir = await hostExtensionDataDirectory(location, true);
      const info = await stat(entry.directory, { bigint: true });
      if (this.#closing) return true;
      const process = new ExtensionBackendProcess({
        diagnose: fail,
        readSettings: async () => {
          assertCurrent();
          return (await readHostExtensionSettings(location)).values;
        },
        writeSettings: async (raw) => {
          const values = jsonObjectSchema.parse(raw);
          return (await this.#saveSettings({ ...location, values }, assertCurrent)).values;
        },
      });
      instance.process = process;
      await process.activate({
        extensionId: id,
        extensionDir: entry.directory,
        dataDir,
        url: pathToFileURL(entry.scriptPath).href,
        hash: entry.hash,
        installation: `${info.dev}:${info.ino}`,
      });
      assertCurrent();
      instance.state = "running";
      return true;
    } catch (error) {
      if (instance.state !== "failed") fail(errorMessage(error));
      await instance.process?.terminate();
      delete instance.process;
      return false;
    }
  }

  async #stop(id: string): Promise<void> {
    const instance = this.#instances.get(id);
    try {
      // Keep settings IPC authorized through dispose; the lifecycle queue prevents
      // new invocations and replacement of the activation until stop settles.
      await instance?.process?.stop();
    } catch (error) {
      this.diagnose(`Host extension backend (${id} dispose): ${errorMessage(error)}`);
    } finally {
      this.#instances.delete(id);
    }
  }

  async #stopAll() {
    await Promise.all([...this.#instances.keys()].map((id) => this.#stop(id)));
  }

  #saveSettings(
    input: { dataDir: string } & Omit<
      HostExtensionsRpcParams<typeof RPC.settingsSet>,
      "expectedSettingsRevision"
    > & { expectedSettingsRevision?: number },
    authorize?: () => void,
  ) {
    return this.#withSettings(async () => {
      authorize?.();
      const expectedSettingsRevision =
        input.expectedSettingsRevision ?? (await readHostExtensionSettings(input)).settingsRevision;
      authorize?.();
      const result = await writeHostExtensionSettings({ ...input, expectedSettingsRevision });
      this.#publish();
      return result;
    });
  }

  #withSettings<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#settingsQueue.then(operation);
    this.#settingsQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #publish() {
    this.changed(++this.#revision);
  }

  #assertOpen() {
    if (this.#closing) throw new Error("Host extensions are closing");
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    void this.start();
    return this.#serialize(() => {
      this.#assertOpen();
      return operation();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#queue.then(operation);
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
