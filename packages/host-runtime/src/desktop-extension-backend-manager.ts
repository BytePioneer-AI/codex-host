import { pathToFileURL } from "node:url";
import { BACKEND_ENTRY_CHANGED, ExtensionBackendProcess } from "@codexhost/extension-backend";
import {
  desktopExtensionDataDirectory,
  desktopExtensionsRoot,
  readDesktopExtensionConfiguration,
  readDesktopExtensionSnapshot,
  readDesktopExtensionSettings,
  writeDesktopExtensionSettings,
} from "@codexhost/harness-plugin-files";
import { resolveDesktopExtensionSlots } from "@codexhost/shared-contracts";
import { errorMessage } from "./desktop-rpc.js";

export class DesktopExtensionBackendManager {
  readonly #root: string;
  readonly #instances = new Map<string, { key: string; process?: ExtensionBackendProcess }>();
  #queue = Promise.resolve();
  #poll: NodeJS.Timeout | undefined;
  #pollPending = false;
  #closed = false;
  #lastConfiguration: string | undefined;
  #lastScan = 0;

  constructor(
    private readonly dataDir: string,
    private readonly diagnose: (message: string) => void = () => undefined,
  ) {
    this.#root = desktopExtensionsRoot(dataDir);
  }

  start(): void {
    if (this.#poll || this.#closed) return;
    void this.reconcile();
    // Console is a separate process and commits mutations via enabled.json.
    this.#poll = setInterval(() => {
      if (this.#pollPending) return;
      this.#pollPending = true;
      void this.#enqueue(() => this.#sync(false)).finally(() => {
        this.#pollPending = false;
      });
    }, 1_000);
    this.#poll.unref();
  }

  reconcile(): Promise<void> {
    return this.#enqueue(() => this.#sync(true));
  }

  async invoke(id: string, method: string, params?: unknown): Promise<unknown> {
    await this.#enqueue(() => this.#sync(false));
    const backend = this.#instances.get(id)?.process;
    if (this.#closed || !backend) throw new Error("Desktop extension backend is not active");
    return backend.invoke(method, params);
  }

  close(): Promise<void> {
    if (this.#closed) return this.#queue;
    this.#closed = true;
    clearInterval(this.#poll);
    return this.#enqueue(async () => {
      await Promise.all([...this.#instances.keys()].map((id) => this.#stop(id)));
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    return (this.#queue = this.#queue
      .then(operation)
      .catch((error) => this.#report("reconcile", error)));
  }

  async #sync(force: boolean): Promise<void> {
    if (this.#closed) return;
    if (!force && Date.now() - this.#lastScan < 30_000) {
      const { configuration } = await readDesktopExtensionConfiguration(this.#root);
      if (JSON.stringify(configuration) === this.#lastConfiguration) return;
    }
    const {
      selection: { configuration },
      discovery,
    } = await readDesktopExtensionSnapshot(this.#root, { skipScanIfNoneEnabled: true });
    this.#lastConfiguration = JSON.stringify(configuration);
    this.#lastScan = Date.now();
    const valid = discovery.extensions.flatMap((entry) => (entry.state === "valid" ? [entry] : []));
    const { active } = resolveDesktopExtensionSlots(
      configuration.enabled,
      valid.map(({ manifest }) => manifest),
    );
    const selected = new Set(active);
    const desired = new Map(
      valid.flatMap(({ id, hash, backend }) =>
        selected.has(id) && backend
          ? [
              [
                id,
                {
                  ...backend,
                  key: JSON.stringify([
                    hash,
                    backend.hash,
                    backend.installation,
                    backend.scriptPath,
                  ]),
                },
              ] as const,
            ]
          : [],
      ),
    );
    await Promise.all(
      [...this.#instances].map(async ([id, instance]) => {
        if (desired.get(id)?.key !== instance.key) await this.#stop(id);
      }),
    );
    if (this.#closed) return;
    await Promise.all(
      [...desired].map(async ([id, entry]) => {
        if (this.#instances.has(id)) return;
        const instance: { key: string; process?: ExtensionBackendProcess } = {
          key: entry.key,
        };
        // Remember activation failures for this revision rather than retrying on every poll.
        this.#instances.set(id, instance);
        let backend: ExtensionBackendProcess | undefined;
        try {
          const dataDir = await desktopExtensionDataDirectory({ dataDir: this.dataDir, id }, true);
          if (this.#closed) return;
          const location = { dataDir: this.dataDir, id };
          backend = new ExtensionBackendProcess({
            readSettings: () => readDesktopExtensionSettings(location),
            writeSettings: (values) => writeDesktopExtensionSettings({ ...location, values }),
            env: process.env,
            diagnose: (error) => this.#report(id, error),
          });
          await backend.activate({
            extensionId: id,
            extensionDir: entry.directory,
            dataDir,
            url: `${pathToFileURL(entry.scriptPath).href}?v=${entry.hash}`,
            hash: entry.hash,
            installation: entry.installation,
          });
          instance.process = backend;
        } catch (error) {
          if (error instanceof Error && error.message === BACKEND_ENTRY_CHANGED) {
            // The next poll or invocation must take a fresh snapshot, even at the same revision.
            this.#instances.delete(id);
            this.#lastConfiguration = undefined;
          } else {
            this.#report(`${id} activate`, error);
          }
          await backend?.terminate();
        }
      }),
    );
  }

  async #stop(id: string): Promise<void> {
    const instance = this.#instances.get(id);
    this.#instances.delete(id);
    try {
      await instance?.process?.stop();
    } catch (error) {
      this.#report(`${id} dispose`, error);
    }
  }

  #report(phase: string, error: unknown): void {
    this.diagnose(`Desktop extension backend (${phase}): ${errorMessage(error)}`);
  }
}
