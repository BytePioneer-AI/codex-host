import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessUsageStatisticsAdapter } from "@codexhost/harness-adapter/plugin";
import {
  HARNESS_PLUGIN_SURFACES,
  isHarnessPluginInScope,
  type HarnessId,
  type HarnessPluginDescriptor,
  type HarnessPluginScope,
  type HarnessPluginSurface,
} from "@codexhost/shared-contracts";

import { HostPluginRuntime } from "./host-plugin-runtime.js";

type PluginAdapter = HarnessAdapter | HarnessUsageStatisticsAdapter;

/** One registry belongs to one Host connection, not to the process global scope. */
export class HarnessPluginRegistry {
  readonly #entries = new Map<
    HarnessId,
    {
      descriptor: HarnessPluginDescriptor;
      adapter: PluginAdapter;
      surfaces: ReadonlySet<HarnessPluginSurface>;
    }
  >();
  /** Surfaces declared by installed plugins this Host does not mount (Desktop window Hosts). */
  readonly #declaredSurfaces = new Map<HarnessId, ReadonlySet<HarnessPluginSurface>>();
  readonly #runtime = new HostPluginRuntime();
  readonly #cleanupErrors: unknown[] = [];
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(readonly scope: HarnessPluginScope = "external") {}

  register(
    descriptor: HarnessPluginDescriptor,
    adapter: PluginAdapter,
    surfaces: readonly HarnessPluginSurface[] = HARNESS_PLUGIN_SURFACES,
  ): Promise<void> {
    if (this.#closed) throw new Error("Plugin registry is closed");
    if (!isHarnessPluginInScope(descriptor.id, this.scope))
      throw new Error("Plugin identity is outside this runtime's scope");
    if (adapter.harnessId !== descriptor.id) throw new Error("Plugin Adapter identity mismatch");
    if (this.#entries.has(descriptor.id)) throw new Error("Duplicate Harness plugin identity");
    if ((descriptor.kind === "usage") === "open" in adapter) {
      throw new Error("Plugin kind does not match its Adapter");
    }
    return this.#runtime.mount({
      name: descriptor.id,
      apply: (ctx) => {
        ctx.effect(() => {
          this.#entries.set(descriptor.id, {
            descriptor: structuredClone(descriptor),
            adapter,
            surfaces: new Set(surfaces),
          });
          return async () => {
            this.#entries.delete(descriptor.id);
            try {
              await adapter.close();
            } catch (error) {
              // Cordis logs disposer failures; retain the existing public close rejection too.
              this.#cleanupErrors.push(error);
            }
          };
        });
      },
    });
  }

  get adapters(): ReadonlyMap<HarnessId, HarnessAdapter> {
    return new Map(
      [...this.#entries].flatMap(([id, { descriptor, adapter }]) =>
        descriptor.kind !== "usage" && "open" in adapter ? [[id, adapter] as const] : [],
      ),
    );
  }

  get usageAdapters(): ReadonlyMap<HarnessId, HarnessUsageStatisticsAdapter> {
    return new Map(
      [...this.#entries].flatMap(([id, { descriptor, adapter }]) =>
        descriptor.kind === "usage" && !("open" in adapter) ? [[id, adapter] as const] : [],
      ),
    );
  }

  list(): HarnessPluginDescriptor[] {
    return [...this.#entries.values()].map(({ descriptor }) => structuredClone(descriptor));
  }

  /**
   * Record where an installed plugin is presented without mounting it. A Host that forwards
   * sessions elsewhere still lists stored Threads and must hide those of Web-only Harnesses.
   */
  declareSurfaces(id: HarnessId, surfaces: readonly HarnessPluginSurface[]): void {
    if (this.#closed) throw new Error("Plugin registry is closed");
    this.#declaredSurfaces.set(id, new Set(surfaces));
  }

  /** Presentation surfaces per Harness; execution and storage ownership stay unchanged. */
  surfaces(): ReadonlyMap<HarnessId, ReadonlySet<HarnessPluginSurface>> {
    return new Map([
      ...this.#declaredSurfaces,
      ...[...this.#entries].map(([id, entry]) => [id, entry.surfaces] as const),
    ]);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#runtime.close().then(() => {
      if (this.#cleanupErrors.length)
        throw new AggregateError(this.#cleanupErrors, "Harness plugin cleanup failed");
    });
    return this.#closing;
  }
}
