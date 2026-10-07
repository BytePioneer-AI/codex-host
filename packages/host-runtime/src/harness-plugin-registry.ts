import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessUsageStatisticsAdapter } from "@codexhost/harness-adapter/plugin";
import type { HarnessId, HarnessPluginDescriptor } from "@codexhost/shared-contracts";

type PluginAdapter = HarnessAdapter | HarnessUsageStatisticsAdapter;

/** One registry belongs to one Host connection, not to the process global scope. */
export class HarnessPluginRegistry {
  readonly #entries = new Map<
    HarnessId,
    { descriptor: HarnessPluginDescriptor; adapter: PluginAdapter }
  >();
  #closed = false;
  #closing: Promise<void> | undefined;

  register(descriptor: HarnessPluginDescriptor, adapter: PluginAdapter): void {
    if (this.#closed) throw new Error("Plugin registry is closed");
    if (adapter.harnessId !== descriptor.id) throw new Error("Plugin Adapter identity mismatch");
    if (this.#entries.has(descriptor.id)) throw new Error("Duplicate Harness plugin identity");
    if ((descriptor.kind === "usage") === "open" in adapter) {
      throw new Error("Plugin kind does not match its Adapter");
    }
    this.#entries.set(descriptor.id, { descriptor: structuredClone(descriptor), adapter });
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
    const adapters = [...new Set([...this.#entries.values()].map(({ adapter }) => adapter))];
    this.#closing = Promise.allSettled(
      adapters.map((adapter) => Promise.resolve().then(() => adapter.close())),
    ).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Harness plugin cleanup failed");
    });
    return this.#closing;
  }
}
