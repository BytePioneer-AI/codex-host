import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Native command history can be appended at completion, after later user inputs.
 * Reorder only fully timestamped Items; do not infer missing native chronology. */
function chronological(items: JsonValue[]): JsonValue[] {
  if (!items.every((item) => object(item) && time(item.startedAtMs))) return items;
  return items.toSorted((left, right) =>
    object(left) && object(right) && time(left.startedAtMs) && time(right.startedAtMs)
      ? left.startedAtMs - right.startedAtMs
      : 0,
  );
}

/** Commands announced by native notifications but not yet present in native history.
 * This is a volatile projection, not another persisted transcript or execution owner. */
export class NativeClientItems {
  readonly #commands = new Map<string, { threadId: string; turnId: string; item: JsonObject }>();

  observe(method: string, params: JsonObject): void {
    if (typeof params.threadId !== "string") return;
    if (method === "thread/closed") {
      for (const [key, entry] of this.#commands)
        if (entry.threadId === params.threadId) this.#commands.delete(key);
      return;
    }
    if (typeof params.turnId !== "string") return;
    const item = object(params.item) ? params.item : undefined;
    const id = item?.id ?? params.itemId;
    if (typeof id !== "string") return;
    const key = JSON.stringify([params.threadId, params.turnId, id]);
    if (
      (method === "item/started" || method === "item/completed") &&
      item?.type === "commandExecution"
    ) {
      const previous = this.#commands.get(key)?.item;
      // A duplicate start must not reopen an already completed command.
      if (method === "item/started" && previous && previous.status !== "inProgress") return;
      this.#commands.set(key, {
        threadId: params.threadId,
        turnId: params.turnId,
        item: structuredClone({
          ...item,
          startedAtMs: item.startedAtMs ?? previous?.startedAtMs ?? params.startedAtMs ?? null,
        }),
      });
      // Bound completed notifications whose Thread is no longer being read.
      const completed = [...this.#commands].filter(
        ([, entry]) => entry.item.status !== "inProgress",
      );
      for (const [old] of completed.slice(0, Math.max(0, completed.length - 256)))
        this.#commands.delete(old);
    } else if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      const entry = this.#commands.get(key);
      if (entry?.item.status === "inProgress")
        entry.item = {
          ...entry.item,
          aggregatedOutput:
            (typeof entry.item.aggregatedOutput === "string" ? entry.item.aggregatedOutput : "") +
            params.delta,
        };
    }
  }

  project(threadId: string, result: JsonObject): JsonObject {
    if (!Array.isArray(result.data)) return result;
    return {
      ...result,
      data: result.data.map((turn) => {
        if (
          !object(turn) ||
          !Array.isArray(turn.items) ||
          turn.itemsView === "notLoaded" ||
          turn.itemsView === "summary"
        )
          return turn;
        const items = [...turn.items];
        for (const [key, entry] of this.#commands) {
          if (entry.threadId !== threadId || entry.turnId !== turn.id) continue;
          const index = items.findIndex((item) => object(item) && item.id === entry.item.id);
          const persisted = index === -1 ? undefined : items[index];
          if (object(persisted) && persisted.status !== "inProgress") {
            // The native full Item owns the completed result and output.
            this.#commands.delete(key);
          } else if (index === -1) items.push(structuredClone(entry.item));
          else
            items[index] = structuredClone({
              ...(object(persisted) ? persisted : {}),
              ...entry.item,
            });
        }
        return { ...turn, items: chronological(items) };
      }),
    };
  }

  clear(): void {
    this.#commands.clear();
  }
}
