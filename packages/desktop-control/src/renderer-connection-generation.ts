import type { RendererHostRpcStore } from "./renderer-host-rpc-discovery.js";

export interface RendererConnectionGeneration {
  readonly owner: object;
  readonly revision: number;
}

/** Undefined preserves older layouts without connection signals; null means a
 * known connection is unavailable or ambiguous. Reads existing signals only.
 * Self-contained for the Controller's Renderer installation expression.
 */
export function readRendererConnectionGeneration(
  store: RendererHostRpcStore | null,
  hostId: string,
): RendererConnectionGeneration | null | undefined {
  if (!store) return undefined;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  const candidates = new Set<Record<string, unknown>>();
  for (const members of store.familyBindings.values()) {
    const value = members.get(hostId)?.value;
    if (
      record(value) &&
      record(value.state$) &&
      record(value.revision$) &&
      record(value.appServerVersion$) &&
      typeof value.state$.get === "function" &&
      typeof value.revision$.get === "function"
    )
      candidates.add(value);
  }
  if (!candidates.size) return undefined;
  if (candidates.size !== 1) return null;
  const owner = candidates.values().next().value;
  if (!owner) return null;
  const state = owner.state$ as { get(): unknown };
  const revision = owner.revision$ as { get(): unknown };
  try {
    const current = revision.get();
    return state.get() === "connected" &&
      typeof current === "number" &&
      Number.isSafeInteger(current)
      ? { owner, revision: current }
      : null;
  } catch {
    return null;
  }
}
