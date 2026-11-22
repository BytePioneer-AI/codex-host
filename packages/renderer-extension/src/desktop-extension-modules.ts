import type { DesktopExtensionStatus } from "@codexhost/shared-contracts";

interface ModuleIdentity {
  id: string;
  kind: "page" | "widget";
  activationId: string;
  digest: string;
  path: string;
}

export interface DesktopExtensionModuleEntry extends ModuleIdentity {
  hash: string;
  create?: () => Promise<{ namespace: unknown }>;
  error?: string;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const key = ({ id, kind }: ModuleIdentity) => `${id}:${kind}`;
const sameModule = (a: ModuleIdentity, b: ModuleIdentity) =>
  a.activationId === b.activationId && a.digest === b.digest && a.path === b.path;

function register(entry: DesktopExtensionModuleEntry) {
  const lifetime = new AbortController();
  let failure = entry.error;
  let state: DesktopExtensionStatus["state"] = failure ? "failed" : "waiting";
  let module: ReturnType<NonNullable<DesktopExtensionModuleEntry["create"]>> | undefined;
  return {
    entry,
    lifetime,
    handle: {
      signal: lifetime.signal,
      load() {
        return (module ??= Promise.resolve().then(() => {
          lifetime.signal.throwIfAborted();
          if (entry.error !== undefined) throw new Error(entry.error);
          if (!entry.create) throw new Error("Missing Desktop extension module factory");
          return entry.create();
        }));
      },
      report(result: { error?: string }) {
        if (lifetime.signal.aborted) return;
        failure = result.error?.slice(0, 2048);
        state = failure !== undefined ? "failed" : "running";
      },
    },
    status(): DesktopExtensionStatus {
      return { hash: entry.hash, state, ...(failure !== undefined ? { error: failure } : {}) };
    },
  };
}

/** The table is reconciled synchronously, independently of legacy Desktop activation or RPC readiness. */
export function createDesktopExtensionModules() {
  let modules = new Map<string, ReturnType<typeof register>>();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const get = (identity: ModuleIdentity) => {
    const current = modules.get(key(identity));
    if (current && sameModule(current.entry, identity)) return current.handle;
  };
  return {
    replace(entries: readonly DesktopExtensionModuleEntry[]) {
      const next = new Map<string, ReturnType<typeof register>>();
      for (const entry of entries) {
        const id = key(entry);
        const old = modules.get(id);
        const reference = !entry.create && entry.error === undefined;
        if (old && sameModule(old.entry, entry) && (reference || entry.error === old.entry.error))
          next.set(id, old);
        else if (entry.create || entry.error !== undefined) next.set(id, register(entry));
      }
      const previous = modules;
      modules = next;
      let changed = previous.size !== next.size;
      for (const [id, old] of previous) {
        if (old === next.get(id)) continue;
        changed = true;
        old.lifetime.abort();
      }
      if (changed)
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // Module readiness must reach other consumers even if a listener fails.
          }
        }
    },
    status() {
      return Object.fromEntries(Array.from(modules, ([id, module]) => [id, module.status()]));
    },
    get,
    subscribe,
    async waitFor(
      identity: ModuleIdentity,
      signal: AbortSignal,
      timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    ) {
      signal.throwIfAborted();
      const available = get(identity);
      if (available) return available;
      return new Promise<NonNullable<ReturnType<typeof get>>>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          signal.removeEventListener("abort", onAbort);
          reject(new Error(`Timed out waiting for Desktop extension module "${identity.id}"`));
        }, timeoutMs);
        const stop = subscribe(() => {
          const next = get(identity);
          if (!next) return;
          clearTimeout(timer);
          stop();
          signal.removeEventListener("abort", onAbort);
          resolve(next);
        });
        const onAbort = () => {
          clearTimeout(timer);
          stop();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
