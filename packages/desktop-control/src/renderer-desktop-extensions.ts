import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import {
  DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES,
  desktopExtensionStatusSchema,
  desktopExtensionsDiagnosticSchema,
  resolveDesktopExtensionSlots,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import {
  desktopExtensionsRoot,
  desktopExtensionsStatusPath,
  isDesktopExtensionTransactionEntry,
  readDesktopExtensionSnapshot,
  type DesktopExtensionInstallation,
} from "@codexhost/harness-plugin-files";

export interface ExtensionRenderer {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
}

type Installed = Extract<DesktopExtensionInstallation, { state: "valid" }>;
interface Application {
  id: string;
  hash: string;
  expression: string;
  reference: string;
}
interface Target {
  id: string;
  renderer: ExtensionRenderer;
  scriptId?: string;
  fingerprint?: string;
  enabled: boolean;
  cleanupPending?: boolean;
  extensions: Record<string, DesktopExtensionStatus>;
}

const HOST = "window.__codexhostDesktopExtensionsV1";
const STATUS = `${HOST}?.status() ?? null`;
const RESCAN_MS = 30_000;
const POLL_MS = 5_000;
const DEBOUNCE_MS = 150;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function application(item: Installed): Application | undefined {
  const { id, hash, manifest, script, style } = item;
  if (script === undefined) return undefined;
  const reference = JSON.stringify({ id, hash, slots: manifest.slots });
  const factory = `(function (define) { "use strict";\n${script}\n})`;
  let expression: string;
  try {
    // Parse individually without running code, so one syntax error cannot
    // prevent parsing unrelated extensions in the full new-document script.
    new Script(`({defineScript: ${factory}})`, {
      filename: `codexhost-extension://${id}/desktop.js`,
    });
    expression = `{...${reference}, defineScript: ${factory},${style === undefined ? "" : `style: ${JSON.stringify(style)},`}}`;
  } catch (cause) {
    expression = JSON.stringify({
      id,
      hash,
      slots: manifest.slots,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return { id, hash, expression, reference };
}

function reconciliation(entries: readonly string[]): string {
  return `(() => {
    if (window.top !== window || location.protocol !== "app:" || location.host !== "-" || location.pathname !== "/index.html" || !${HOST}) return false;
    void ${HOST}.reconcile([${entries.join(",\n")}]); return true;
  })()`;
}

export class RendererDesktopExtensions {
  readonly #root: string;
  readonly #statusPath: string;
  readonly #scan: NodeJS.Timeout;
  readonly #poll: NodeJS.Timeout;
  #debounce: NodeJS.Timeout | undefined;
  #watch: FSWatcher | undefined;
  #watchingRoot = false;
  #target: Target | undefined;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();
  #pendingScan: Promise<void> | undefined;
  #pendingPoll = false;
  #lastEnsure = 0;
  #handled: string | undefined;
  #attempted: string | undefined;
  #loadedToken = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly diagnose: (error: unknown) => void = () => undefined,
  ) {
    this.#root = desktopExtensionsRoot(dataDirectory);
    this.#statusPath = desktopExtensionsStatusPath(dataDirectory);
    this.#scan = setInterval(() => {
      void this.refresh();
    }, RESCAN_MS);
    this.#scan.unref();
    this.#poll = setInterval(() => this.#pollStatus(), POLL_MS);
    this.#poll.unref();
  }

  attach(id: string, renderer: ExtensionRenderer): () => Promise<void> {
    const target: Target = { id, renderer, enabled: false, extensions: {} };
    this.#target = target;
    // A new CDP session has no previous new-document registrations. Its
    // current document can still contain the old, already-running instances.
    void this.#enqueue(() => this.#reconcile(target));
    return () => {
      if (this.#target === target) this.#target = undefined;
      // Wait out any in-flight registration before removing its identifier.
      // Detach still has to remove the script after close() stops reconciliation.
      this.#queue = this.#queue.then(() => this.#replaceSnapshot(target, [])).catch(this.diagnose);
      return this.#queue;
    };
  }

  ensureInstalled(): void {
    const now = Date.now();
    if (now - this.#lastEnsure < POLL_MS) return;
    this.#lastEnsure = now;
    this.hint();
  }

  hint(): void {
    if (this.#closed) return;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      void this.refresh();
    }, DEBOUNCE_MS);
    this.#debounce.unref();
  }

  refresh(): Promise<void> {
    if (this.#pendingScan) return this.#pendingScan;
    const promise = this.#enqueue(async () => {
      const target = this.#target;
      if (target) await this.#reconcile(target);
    });
    this.#pendingScan = promise;
    void promise.finally(() => {
      if (this.#pendingScan === promise) this.#pendingScan = undefined;
    });
    return promise;
  }

  close(): void {
    this.#closed = true;
    this.#target = undefined;
    clearTimeout(this.#debounce);
    clearInterval(this.#scan);
    clearInterval(this.#poll);
    this.#watch?.close();
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue
      .then(async () => {
        if (!this.#closed) await operation();
      })
      .catch(this.diagnose);
    return this.#queue;
  }

  #ensureWatch(): void {
    if (this.#watchingRoot || this.#closed) return;
    const onChange = (event: string, filename: string | null) => {
      // A read snapshot takes the same lock as installers; it isn't a package change.
      if (filename && isDesktopExtensionTransactionEntry(filename.split(path.sep, 1)[0] ?? ""))
        return;
      if (event === "rename" && this.#watchingRoot) {
        this.#watch?.close();
        this.#watch = undefined;
        this.#watchingRoot = false;
      }
      this.hint();
    };
    const install = (directory: string, recursive: boolean) => {
      const watcher = watch(directory, { recursive, persistent: false }, onChange);
      watcher.on("error", () => {
        if (this.#watch !== watcher) return;
        watcher.close();
        this.#watch = undefined;
        this.#watchingRoot = false;
      });
      return watcher;
    };
    try {
      const root = install(this.#root, true);
      this.#watch?.close();
      this.#watch = root;
      this.#watchingRoot = true;
    } catch {
      if (!this.#watch) {
        try {
          this.#watch = install(this.dataDirectory, false);
        } catch {
          /* Periodic scan covers missed watches. */
        }
      }
    }
  }

  async #readRenderer(target: Target): Promise<Record<string, DesktopExtensionStatus> | null> {
    const value = await target.renderer.evaluate<unknown>(STATUS, 1_000);
    if (!record(value)) return null;
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, raw]) => {
        const status = desktopExtensionStatusSchema.safeParse(raw);
        return status.success ? [[id, status.data]] : [];
      }),
    );
  }

  async #replaceSnapshot(target: Target, entries: Application[]): Promise<void> {
    const fingerprint = JSON.stringify(entries.map(({ id, hash }) => [id, hash]));
    if (target.fingerprint === fingerprint) return;
    if (target.scriptId) {
      await target.renderer.command("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: target.scriptId,
      });
      delete target.scriptId;
      delete target.fingerprint;
    }
    if (this.#target !== target || this.#closed) return;
    if (entries.length) {
      const added = await target.renderer.command("Page.addScriptToEvaluateOnNewDocument", {
        source: reconciliation(entries.map(({ expression }) => expression)),
      });
      if (!record(added) || typeof added.identifier !== "string")
        throw new Error("CDP did not identify the extension snapshot");
      target.scriptId = added.identifier;
    }
    target.fingerprint = fingerprint;
  }

  async #reconcile(target: Target): Promise<void> {
    if (this.#target !== target || this.#closed) return;
    this.#ensureWatch();
    if (!this.#loadedToken) {
      this.#loadedToken = true;
      try {
        this.#handled = desktopExtensionsDiagnosticSchema.parse(
          JSON.parse(await readFile(this.#statusPath, "utf8")),
        ).handledReloadToken;
      } catch {
        /* No completed recovery to remember. */
      }
    }
    const {
      selection: { configuration },
      discovery,
    } = await readDesktopExtensionSnapshot(this.#root);
    if (this.#target !== target || this.#closed) return;
    target.enabled = configuration.enabled.length > 0;
    const token = configuration.reloadToken;
    if (token && token !== this.#handled) {
      if (target.enabled) {
        // A newer enable supersedes recovery, even if applying that selection fails.
        await this.#recordReloadToken(target, token);
      } else {
        await this.#replaceSnapshot(target, []);
        if (token !== this.#attempted) {
          await target.renderer.evaluate(reconciliation([]), 1_000).catch(() => undefined);
          if (this.#target !== target || this.#closed) return;
          await target.renderer.command("Page.reload");
          this.#attempted = token;
        }
        target.extensions = {};
        await this.#recordReloadToken(target, token);
        this.hint();
        return;
      }
    }
    const desired: Application[] = [];
    const statuses = new Map<string, DesktopExtensionStatus>();
    const valid = new Map<string, Installed>();
    for (const item of discovery.extensions) {
      if (item.state === "valid") valid.set(item.id, item);
      else statuses.set(item.id, { state: item.state, error: item.error });
    }
    const { active, conflicts } = resolveDesktopExtensionSlots(
      configuration.enabled,
      [...valid.values()].map(({ manifest }) => manifest),
    );
    let remaining = DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES - 512;
    for (const id of active) {
      const installed = valid.get(id);
      const item = installed && application(installed);
      if (!item) continue;
      const bytes = Buffer.byteLength(item.expression) + 2;
      if (bytes > remaining)
        statuses.set(id, {
          state: "failed",
          hash: item.hash,
          error: "Desktop extension snapshot size limit exceeded",
        });
      else {
        remaining -= bytes;
        desired.push(item);
      }
    }
    for (const [id, conflictWith] of conflicts) {
      const item = valid.get(id);
      if (item) statuses.set(id, { state: "conflict", conflictWith, hash: item.hash });
    }
    for (const id of configuration.enabled)
      if (!valid.has(id) && !statuses.has(id))
        statuses.set(id, {
          state: "invalid",
          error: discovery.diagnostic ?? "Extension directory not found",
        });
    // Check current state even on the first reconciliation after re-attachment.
    const before = await this.#readRenderer(target).catch(() => null);
    if (this.#target !== target || this.#closed) return;
    await this.#replaceSnapshot(target, desired);
    const matches = (item: Application) =>
      before &&
      Object.hasOwn(before, item.id) &&
      before[item.id]?.hash === item.hash &&
      (before[item.id]?.state === "running" || before[item.id]?.state === "waiting");
    const activeIds = new Set(desired.map(({ id }) => id));
    const old = Object.entries(before ?? {}).some(
      ([id, state]) => !activeIds.has(id) && state.state !== "disabled",
    );
    target.cleanupPending = old;
    if (old || desired.some((item) => !matches(item))) {
      await target.renderer.evaluate(
        reconciliation(desired.map((item) => (matches(item) ? item.reference : item.expression))),
        1_000,
      );
    }
    const observed = await this.#readRenderer(target).catch(() => null);
    for (const item of desired) {
      const status = observed?.[item.id];
      statuses.set(
        item.id,
        status?.hash === item.hash ? status : { state: "waiting", hash: item.hash },
      );
    }
    for (const [id, status] of Object.entries(observed ?? {}))
      if (!statuses.has(id) && status.state === "disabled" && status.error)
        statuses.set(id, status);
    target.extensions = Object.fromEntries(statuses);
    await this.#publish(target);
  }

  async #recordReloadToken(target: Target, token: string): Promise<void> {
    if (this.#target !== target || this.#closed) return;
    const previous = this.#handled;
    this.#handled = token;
    try {
      await this.#publish(target);
    } catch (error) {
      this.#handled = previous;
      throw error;
    }
  }

  #pollStatus(): void {
    if (this.#pendingPoll || !this.#target) return;
    this.#pendingPoll = true;
    void this.#enqueue(async () => {
      const target = this.#target;
      if (!target) return;
      if (target.enabled || target.cleanupPending) {
        const observed = await this.#readRenderer(target).catch(() => null);
        for (const [id, status] of Object.entries(observed ?? {})) {
          if (status.state === "disabled" && status.error && !Object.hasOwn(target.extensions, id))
            Object.defineProperty(target.extensions, id, {
              value: status,
              enumerable: true,
              configurable: true,
              writable: true,
            });
        }
        if (observed)
          target.cleanupPending = Object.entries(observed).some(
            ([id, status]) => status.state !== "disabled" && !Object.hasOwn(target.extensions, id),
          );
        for (const [id, item] of Object.entries(target.extensions)) {
          if (
            item.state === "invalid" ||
            item.state === "conflict" ||
            item.state === "incompatible" ||
            item.state === "disabled"
          )
            continue;
          const status = observed && Object.hasOwn(observed, id) ? observed[id] : undefined;
          if (status && status.hash === item.hash) target.extensions[id] = status;
          else if (item.state !== "failed")
            target.extensions[id] = { state: "waiting", ...(item.hash ? { hash: item.hash } : {}) };
        }
      }
      await this.#publish(target);
    }).finally(() => {
      this.#pendingPoll = false;
    });
  }

  async #publish(target: Target): Promise<void> {
    if (this.#target !== target || this.#closed) return;
    const doc = {
      controllerPid: process.pid,
      targetId: target.id,
      updatedAt: new Date().toISOString(),
      ...(this.#handled ? { handledReloadToken: this.#handled } : {}),
      extensions: target.extensions,
    };
    await mkdir(path.dirname(this.#statusPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#statusPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(doc), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#statusPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
