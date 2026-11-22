/**
 * Production client composition without the page: mount the Loader over a
 * module system, create built-in core manifest rows, wait for quiescence, and
 * audit core activation. Optional external DSH plugins are deferred so a broken
 * external plugin never blocks first-paint rendering.
 * @module @deepseek-ai/dsh-client-web/src/boot-client
 */
import type { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type {
  BootManifest,
  BootPluginRow,
  ClientModuleLoader,
} from "@deepseek-ai/dsh-client-modules/client";
import { STATE_LABELS } from "./loader-status.ts";

/**
 * Built-in client plugins shipped by CodexHost (aligned with `apps/web-ui/import-manifest.json`).
 * Any manifest entry outside this set is treated as an optional external DSH extension.
 */
export const BUILTIN_CLIENT_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-shortcuts",
  "@deepseek-ai/dsh-client-ui-shortcuts",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-resources",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-sidebar-right",
  "@deepseek-ai/dsh-client-ui-sidebar-files",
  "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
  "@deepseek-ai/dsh-client-ui-sidebar-terminal",
  "@deepseek-ai/dsh-client-ui-sidebar-browser",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-general",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-approval",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-brand-official",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-commands",
  "@deepseek-ai/dsh-client-ui-subagent",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-client-ui-permission-presets",
  "@deepseek-ai/dsh-client-ui-plan",
  "@deepseek-ai/dsh-client-ui-user-questions",
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/dsh-client-file-upload",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-terminal-controller",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-client-ui-directory-picker-browse",
  "@deepseek-ai/dsh-client-ui-codexhost",
  "@deepseek-ai/dsh-api-workspace-files",
  "@deepseek-ai/dsh-client-hmr",
]);

/** Partition result separating built-in core entries from optional external DSH entries. */
export interface PartitionedBootManifest {
  readonly core: BootManifest;
  readonly external: readonly BootPluginRow[];
}

/**
 * Split a boot manifest into built-in core plugins and optional external DSH plugins.
 * If a synthetic test manifest contains no known built-in ids at all, every entry stays core.
 */
export function partitionBootManifest(
  manifest: BootManifest,
  isCorePlugin: (id: string) => boolean = (id) => BUILTIN_CLIENT_PLUGIN_IDS.has(id),
): PartitionedBootManifest {
  const hasAnyCore = manifest.plugins.some((row) => isCorePlugin(row.id));
  if (!hasAnyCore) {
    return { core: manifest, external: [] };
  }
  const coreIds = new Set(
    manifest.plugins.filter((row) => isCorePlugin(row.id)).map((row) => row.id),
  );
  const external = manifest.plugins.filter((row) => !coreIds.has(row.id));
  const externalIds = new Set(external.map((row) => row.id));
  return {
    core: {
      rev: manifest.rev,
      // Keep every shared library module (clsx, zod, dsh-util-*, etc.); only defer external plugin entries.
      modules: manifest.modules.filter((row) => !externalIds.has(row.id)),
      plugins: manifest.plugins.filter((row) => coreIds.has(row.id)),
    },
    external,
  };
}

/** Entry state label as the boot page renders it. */
export type EntryStateLabel =
  (typeof STATE_LABELS)[keyof typeof STATE_LABELS] | "loading" | "failed";

/** Inputs of {@link bootClient}. */
export interface ClientBootOptions {
  /** Fresh root Context that will own the plugin tree. */
  readonly ctx: Context;
  /** Module system installed as `loader.internal`. */
  readonly modules: ClientModuleLoader;
  /** Parsed manifest whose `plugins` rows become Loader entries (entry name = row id). */
  readonly manifest: BootManifest;
  /** Per-entry state reporting (the boot page); omitted when no one renders progress. */
  readonly onEntryState?: (name: string, state: EntryStateLabel) => void;
}

/**
 * Compose the client: `ctx.plugin(Loader)`, `loader.internal = modules`, one
 * `loader.create({ name })` per core manifest row, `loader.await()`, then
 * {@link assertEntriesActive}. A row whose module cannot be imported is marked
 * failed; the Loader logs its import error, the module system records it, and
 * the audit rejects startup with that error text per entry.
 * @param options - context, module system, manifest, optional progress sink.
 * @returns resolves after every entry in `manifest` is active; rejects with the audit report otherwise.
 */
export async function bootClient(options: ClientBootOptions): Promise<void> {
  const { ctx, manifest, onEntryState } = options;
  await ctx.plugin(Loader);
  const loader = ctx.loader;
  loader.internal = options.modules as never;

  const expectedIds = new Set(manifest.plugins.map((row) => row.id));
  const offStatus = ctx.on("internal/status", (fiber) => {
    const entry = fiber.entry;
    if (entry === undefined || entry.fiber === undefined) return;
    if (!expectedIds.has(entry.options.name)) return;
    onEntryState?.(entry.options.name, STATE_LABELS[entry.fiber.state]);
  });

  try {
    for (const name of expectedIds) onEntryState?.(name, "loading");
    await options.modules.entries.start(loader, manifest);
    for (const entry of loader.entries()) {
      if (expectedIds.has(entry.options.name) && entry.fiber === undefined) {
        onEntryState?.(entry.options.name, "failed");
      }
    }

    await loader.await();
    assertEntriesActive(ctx, options.modules, expectedIds);
  } finally {
    offStatus();
  }
}

/**
 * Reject entries that failed import/apply or still wait on missing services.
 * @param ctx - root Context carrying the Loader.
 * @param modules - the module system whose recorded import failures name why an entry
 *   has no fiber; a row with no record points at the console.
 * @param onlyIds - optional subset of entry names to audit (defaults to all entries).
 * @throws {Error} listing every non-active entry with its reason.
 */
export function assertEntriesActive(
  ctx: Context,
  modules: Pick<ClientModuleLoader, "importError">,
  onlyIds?: ReadonlySet<string>,
): void {
  const failures: string[] = [];
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name;
    if (onlyIds !== undefined && !onlyIds.has(name)) continue;
    if (entry.fiber === undefined) {
      const importError = modules.importError(name);
      failures.push(
        importError === undefined
          ? `${name}: import failed (see console for the import error)`
          : `${name}: import failed: ${importError.message}`,
      );
      continue;
    }
    const state = STATE_LABELS[entry.fiber.state];
    if (state === "active") continue;
    if (state === "pending") {
      const missing = Object.keys(entry.fiber.inject).filter(
        (service) => ctx.get(service) === undefined,
      );
      failures.push(
        `${name}: pending (waiting for service${missing.length === 1 ? "" : "s"}: ${missing.join(", ") || "unknown"})`,
      );
    } else {
      failures.push(`${name}: ${state}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `web boot: ${String(failures.length)} entr${failures.length === 1 ? "y" : "ies"} did not activate\n${failures.join("\n")}`,
    );
  }
}
