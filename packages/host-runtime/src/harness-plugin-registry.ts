import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessUsageStatisticsAdapter } from "@codexhost/harness-adapter/plugin";
import type { HarnessId, HarnessPluginDescriptor } from "@codexhost/shared-contracts";

import { HostPluginRuntime } from "./host-plugin-runtime.js";

type PluginAdapter = HarnessAdapter | HarnessUsageStatisticsAdapter;

/** One registry belongs to one Host connection, not to the process global scope. */
export class HarnessPluginRegistry {
  readonly #entries = new Map<
    HarnessId,
    { descriptor: HarnessPluginDescriptor; adapter: PluginAdapter }
  >();
  readonly #runtime = new HostPluginRuntime();
  readonly #cleanupErrors: unknown[] = [];
  #closed = false;
  #closing: Promise<void> | undefined;

  register(descriptor: HarnessPluginDescriptor, adapter: PluginAdapter): Promise<void> {
    if (this.#closed) throw new Error("Plugin registry is closed");
    if (adapter.harnessId !== descriptor.id) throw new Error("Plugin Adapter identity mismatch");
    if (this.#entries.has(descriptor.id)) throw new Error("Duplicate Harness plugin identity");
    if ((descriptor.kind === "usage") === "open" in adapter) {
      throw new Error("Plugin kind does not match its Adapter");
    }
    return this.#runtime.mount({
      name: descriptor.id,
      apply: (ctx) => {
        ctx.effect(() => {
          this.#entries.set(descriptor.id, { descriptor: structuredClone(descriptor), adapter });
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
