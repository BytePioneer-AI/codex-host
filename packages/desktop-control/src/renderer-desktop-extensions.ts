import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import {
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES,
  desktopExtensionStatusSchema,
  type DesktopExtensionStatus,
  type HostExtensionListItem,
} from "@codexhost/shared-contracts";
import {
  desktopExtensionsStatusPath,
  discoverHostExtensions,
  hostExtensionsRoot,
  readHostExtensionAsset,
} from "@codexhost/harness-plugin-files";
import { linkRendererExtensionModule } from "./renderer-extension-module.js";

export interface ExtensionRenderer {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(
    expression: string,
    timeoutMs?: number,
    options?: { allowUnsafeEvalBlockedByCSP: false },
  ): Promise<T>;
}

type Installed = Extract<HostExtensionListItem, { state: "valid" }>;
const renderHash = ({ activationId, digest }: Installed) =>
  createHash("sha256").update(`${activationId}:${digest}`).digest("hex");
interface Application {
  id: string;
  hash: string;
  expression: string;
  reference: string;
  error?: string;
}
interface Target {
  id: string;
  renderer: ExtensionRenderer;
  scriptId?: string;
  fingerprint?: string;
  enabled: boolean;
  cleanupPending?: boolean;
  surfacesCleanupPending?: boolean;
  extensions: Record<string, DesktopExtensionStatus>;
  surfaces: Record<string, DesktopExtensionStatus>;
  surfaceApplications: Map<string, Application>;
}

const HOST = "window.__codexhostDesktopExtensionsV1";
const STATUS = `({extensions: ${HOST}?.status() ?? null, surfaces: ${HOST}?.modules?.status() ?? null})`;
const RESCAN_MS = 30_000;
const POLL_MS = 5_000;
const DEBOUNCE_MS = 150;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function application(dataDir: string, item: Installed): Promise<Application> {
  const { id, activationId, digest, manifest } = item;
  const hash = renderHash(item);
  const slots = manifest.slots ?? [];
  const reference = JSON.stringify({ id, hash, slots, activationId, digest });
  let expression: string;
  try {
    const desktop = manifest.desktop;
    if (!desktop) throw new Error("Missing desktop manifest entry");
    const read = async (path: string) =>
      Buffer.from(
        (await readHostExtensionAsset({ dataDir, id, activationId, digest, path })).base64,
        "base64",
      ).toString("utf8");
    const [script, style] = await Promise.all([
      read(desktop.script),
      desktop.style ? read(desktop.style) : undefined,
    ]);
    const factory = `(function (define) { "use strict";\n${script}\n})`;
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
      slots,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return { id, hash, expression, reference };
}

function reconciliation(entries: readonly string[], modules: readonly string[]): string {
  return `(() => {
    if (window.top !== window || location.protocol !== "app:" || location.host !== "-" || location.pathname !== "/index.html" || !${HOST}) return false;
    void ${HOST}.reconcile([${entries.join(",\n")}], [${modules.join(",\n")}]); return true;
  })()`;
}

async function surfaceApplication(
  dataDir: string,
  item: Installed,
  kind: "page" | "widget",
): Promise<Application> {
  const { id, activationId, digest, manifest } = item;
  const hash = renderHash(item);
  const surface = manifest[kind];
  if (!surface) throw new Error(`Missing ${kind} manifest entry`);
  const path = surface.entry;
  const reference = JSON.stringify({ id, activationId, digest, hash, kind, path });
  const identity = { id: `${id}:${kind}`, hash, reference };
  try {
    const factory = await linkRendererExtensionModule(dataDir, item, path);
    return { ...identity, expression: `{...${reference}, create: ${factory}}` };
  } catch (cause) {
    const error = (cause instanceof Error ? cause.message : `${path}: ${String(cause)}`).slice(
      0,
      2048,
    );
    return { ...identity, error, expression: `{...${reference}, error: ${JSON.stringify(error)}}` };
  }
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
  #queuedScan: Promise<void> | undefined;
  #pendingPoll = false;
  #lastEnsure = 0;
  constructor(
    readonly dataDirectory: string,
    private readonly diagnose: (error: unknown) => void = () => undefined,
  ) {
    this.#root = hostExtensionsRoot(dataDirectory);
    this.#statusPath = desktopExtensionsStatusPath(dataDirectory);
    this.#scan = setInterval(() => {
      void this.refresh();
    }, RESCAN_MS);
    this.#scan.unref();
    this.#poll = setInterval(() => this.#pollStatus(), POLL_MS);
    this.#poll.unref();
  }

  attach(id: string, renderer: ExtensionRenderer): (retireSurfaces?: boolean) => Promise<void> {
    const target: Target = {
      id,
      renderer,
      enabled: false,
      surfacesCleanupPending: true,
      extensions: {},
      surfaces: {},
      surfaceApplications: new Map(),
    };
    this.#target = target;
    // A new CDP session has no previous new-document registrations. Its
    // current document can still contain the old, already-running instances.
    void this.#enqueue(() => this.#reconcile(target));
    return (retireSurfaces = true) => {
      if (this.#target === target) this.#target = undefined;
      // Wait out any in-flight registration before removing its identifier.
      this.#queue = this.#queue
        .then(async () => {
          try {
            await this.#replaceSnapshot(target, [], []);
          } finally {
            if (
              retireSurfaces &&
              (target.surfaceApplications.size || Object.keys(target.surfaces).length) &&
              (!this.#target || this.#target.id !== target.id)
            ) {
              await renderer
                .evaluate(`${HOST}?.modules?.replace([]); true`, 1_000)
                .catch(() => undefined);
            }
          }
        })
        .catch(this.diagnose);
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
    if (this.#closed) return Promise.resolve();
    // Share only a queued scan: a running one may already have read the old generation.
    return (this.#queuedScan ??= this.#enqueue(async () => {
      this.#queuedScan = undefined;
      const target = this.#target;
      if (target) await this.#reconcile(target);
    }));
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
      // Ignore staging and lock activity; only active generations and selection matter.
      if (filename?.startsWith(".")) return;
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

  async #readRenderer(target: Target) {
    const value = await target.renderer.evaluate<unknown>(STATUS, 1_000).catch(() => null);
    const parse = (entries: unknown) =>
      record(entries)
        ? Object.fromEntries(
            Object.entries(entries).flatMap(([id, raw]) => {
              const status = desktopExtensionStatusSchema.safeParse(raw);
              return status.success ? [[id, status.data]] : [];
            }),
          )
        : null;
    return {
      extensions: parse(record(value) && value.extensions),
      surfaces: parse(record(value) && value.surfaces),
    };
  }

  async #replaceSnapshot(
    target: Target,
    entries: Application[],
    modules: Application[],
  ): Promise<boolean> {
    const fingerprint = JSON.stringify(
      [entries, modules].map((items) =>
        items.map(({ id, hash, expression }) => [
          id,
          hash,
          createHash("sha256").update(expression).digest("hex"),
        ]),
      ),
    );
    if (target.fingerprint === fingerprint) return false;
    if (target.scriptId) {
      await target.renderer.command("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: target.scriptId,
      });
      delete target.scriptId;
      delete target.fingerprint;
    }
    if (this.#target !== target || this.#closed) return false;
    if (entries.length || modules.length) {
      const added = await target.renderer.command("Page.addScriptToEvaluateOnNewDocument", {
        source: reconciliation(
          entries.map(({ expression }) => expression),
          modules.map(({ expression }) => expression),
        ),
      });
      if (!record(added) || typeof added.identifier !== "string")
        throw new Error("CDP did not identify the extension snapshot");
      target.scriptId = added.identifier;
    }
    target.fingerprint = fingerprint;
    return true;
  }

  async #reconcile(target: Target): Promise<void> {
    if (this.#target !== target || this.#closed) return;
    this.#ensureWatch();
    const { configuration, extensions } = await discoverHostExtensions(this.dataDirectory);
    if (this.#target !== target || this.#closed) return;
    target.enabled = false;
    const desired: Application[] = [];
    const modules: Application[] = [];
    const nextCache = new Map<string, Application>();
    const surfaceStatuses: Record<string, DesktopExtensionStatus> = {};
    const statuses = new Map<string, DesktopExtensionStatus>();
    const valid = new Map<string, Installed>();
    for (const item of extensions) {
      if (item.state === "valid") valid.set(item.id, item);
      else statuses.set(item.id, { state: item.state, error: item.error });
    }
    // Reserve room for a short error record for each possible surface (up to two per extension).
    let remaining = DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES - 512 - 4096 * DESKTOP_EXTENSION_LIMIT;
    for (const id of configuration.enabled) {
      const installed = valid.get(id);
      if (!installed) {
        if (!statuses.has(id))
          statuses.set(id, { state: "invalid", error: "Extension directory not found" });
        continue;
      }
      for (const kind of ["page", "widget"] as const) {
        if (!installed.manifest[kind]) continue;
        const key = `${id}:${kind}`;
        const cached = target.surfaceApplications.get(key);
        const item =
          cached?.hash === renderHash(installed)
            ? cached
            : await surfaceApplication(this.dataDirectory, installed, kind);
        const bytes = Buffer.byteLength(item.expression) + 2;
        if (bytes > remaining) {
          // Send an explicit failure in lieu of leaving a renderer waiting for a factory.
          const error = "Desktop extension snapshot size limit exceeded";
          modules.push({
            ...item,
            expression: `{...${item.reference}, error: ${JSON.stringify(error)}}`,
          });
          surfaceStatuses[key] = { state: "failed", hash: item.hash, error };
        } else {
          remaining -= bytes;
          modules.push(item);
          nextCache.set(key, item);
          if (item.error !== undefined)
            surfaceStatuses[key] = { state: "failed", hash: item.hash, error: item.error };
        }
      }
      if (!installed.manifest.desktop) continue;
      if (installed.desktopConflictWith) {
        statuses.set(id, {
          state: "conflict",
          hash: renderHash(installed),
          conflictWith: installed.desktopConflictWith,
        });
        continue;
      }
      target.enabled = true;
      const item = await application(this.dataDirectory, installed);
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
    // Check current state even on the first reconciliation after re-attachment.
    const { extensions: before, surfaces: beforeModules } = await this.#readRenderer(target);
    if (this.#target !== target || this.#closed) return;
    target.surfaceApplications = nextCache;
    const snapshotChanged = await this.#replaceSnapshot(target, desired, modules);
    const moduleMatches = (item: Application) =>
      !snapshotChanged && beforeModules?.[item.id]?.hash === item.hash;
    const activeModuleKeys = new Set(modules.map(({ id }) => id));
    const staleModules = beforeModules
      ? Object.keys(beforeModules).some((key) => !activeModuleKeys.has(key))
      : Object.keys(target.surfaces).length > 0 || Boolean(target.surfacesCleanupPending);
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
    const evaluateLive =
      old ||
      staleModules ||
      desired.some((item) => !matches(item)) ||
      modules.some((item) => !moduleMatches(item));
    if (evaluateLive) {
      await target.renderer.evaluate(
        reconciliation(
          desired.map((item) => (matches(item) ? item.reference : item.expression)),
          modules.map((item) => (moduleMatches(item) ? item.reference : item.expression)),
        ),
        1_000,
        { allowUnsafeEvalBlockedByCSP: false },
      );
    }
    const { extensions: observed, surfaces: observedModules } = await this.#readRenderer(target);
    target.surfacesCleanupPending =
      !evaluateLive && beforeModules === null && observedModules === null;
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
    for (const item of modules) {
      const status = observedModules?.[item.id];
      surfaceStatuses[item.id] =
        status?.hash === item.hash
          ? status
          : (surfaceStatuses[item.id] ?? { state: "waiting", hash: item.hash });
    }
    target.surfaces = surfaceStatuses;
    await this.#publish(target);
  }

  #pollStatus(): void {
    if (this.#pendingPoll || !this.#target) return;
    this.#pendingPoll = true;
    void this.#enqueue(async () => {
      const target = this.#target;
      if (!target) return;
      const hasSurfaces = Object.keys(target.surfaces).length > 0;
      const { extensions: observed, surfaces: observedModules } =
        target.enabled || target.cleanupPending || hasSurfaces
          ? await this.#readRenderer(target)
          : { extensions: null, surfaces: null };
      if (target.enabled || target.cleanupPending) {
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
      if (hasSurfaces) {
        let missing = false;
        for (const [id, item] of Object.entries(target.surfaces)) {
          const status = observedModules?.[id];
          if (status?.hash === item.hash && status) target.surfaces[id] = status;
          else missing = true;
        }
        if (missing) this.hint();
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
      extensions: target.extensions,
      ...(Object.keys(target.surfaces).length ? { surfaces: target.surfaces } : {}),
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
