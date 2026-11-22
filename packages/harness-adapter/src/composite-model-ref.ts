export interface CompositeModelIdentity {
  readonly provider: string;
  readonly model: string;
}

/**
 * Readable Model Ref IDs for Harnesses that identify a Model by Provider and Model.
 * Each distinct pair gets `<provider>/<model>`; pairs whose readable IDs collide keep
 * `fallbackId(entry)` so every pair stays distinguishable. Resolve a Ref by exact
 * lookup in the returned map, never by splitting the ID.
 */
export function compositeModelRefIds<T extends CompositeModelIdentity>(
  entries: readonly T[],
  fallbackId: (entry: T) => string,
): Map<string, T> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = `${entry.provider}/${entry.model}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = new Map<string, T>();
  for (const entry of entries) {
    const id = `${entry.provider}/${entry.model}`;
    ids.set(counts.get(id) === 1 ? id : fallbackId(entry), entry);
  }
  return ids;
}
