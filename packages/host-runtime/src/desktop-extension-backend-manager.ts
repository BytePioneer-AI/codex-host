import { pathToFileURL } from "node:url";
import {
  desktopExtensionDataDirectory,
  desktopExtensionsRoot,
  discoverDesktopExtensions,
  readDesktopExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { resolveDesktopExtensionSlots } from "@codexhost/shared-contracts";
import { DesktopExtensionBackendProcess } from "./desktop-extension-backend-process.js";
import { errorMessage } from "./desktop-rpc.js";

export class DesktopExtensionBackendManager {
  readonly #root: string;
  readonly #instances = new Map<
    string,
    { key: string; process?: DesktopExtensionBackendProcess }
  >();
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
    const { configuration } = await readDesktopExtensionConfiguration(this.#root);
    const selection = JSON.stringify(configuration);
    if (!force && selection === this.#lastConfiguration && Date.now() - this.#lastScan < 30_000)
      return;
    this.#lastConfiguration = selection;
    this.#lastScan = Date.now();
    const valid =
      configuration.enabled.length === 0
        ? []
        : (await discoverDesktopExtensions(this.#root)).extensions.flatMap((entry) =>
            entry.state === "valid" ? [entry] : [],
          );
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
        const instance: { key: string; process?: DesktopExtensionBackendProcess } = {
          key: entry.key,
        };
        // Remember activation failures for this revision rather than retrying on every poll.
        this.#instances.set(id, instance);
        let backend: DesktopExtensionBackendProcess | undefined;
        try {
          const dataDir = await desktopExtensionDataDirectory({ dataDir: this.dataDir, id }, true);
          if (this.#closed) return;
          backend = new DesktopExtensionBackendProcess(this.dataDir, id, (error) =>
            this.#report(id, error),
          );
          await backend.activate({
            extensionId: id,
            extensionDir: entry.directory,
            dataDir,
            url: `${pathToFileURL(entry.scriptPath).href}?v=${entry.hash}`,
          });
          instance.process = backend;
        } catch (error) {
          this.#report(`${id} activate`, error);
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
