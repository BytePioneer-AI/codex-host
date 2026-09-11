import type { HostEvent, HostItemSnapshot } from "@codexhost/harness-adapter";

/** Read-only view of the current native Turn, using the Session's validated live output. */
export class ModernObservation {
  readonly #items = new Map<string, { snapshot: HostItemSnapshot; completed: boolean }>();

  accept(event: HostEvent): void {
    if (event.type === "turn.started" || event.type === "turn.completed") {
      this.#items.clear();
    } else if (event.type === "item.started") {
      this.#items.set(event.item.itemId, {
        snapshot: { item: structuredClone(event.item), outcome: { status: "succeeded" } },
        completed: false,
      });
    } else if (event.type === "item.updated") {
      const entry = this.#items.get(event.itemId);
      if (!entry) return;
      const item = entry.snapshot.item;
      if (
        event.update.type === "text.append" &&
        (item.type === "agentMessage" || item.type === "reasoning")
      ) {
        item.text += event.update.text;
      }
    } else if (event.type === "item.completed") {
      this.#items.set(event.snapshot.item.itemId, {
        snapshot: structuredClone(event.snapshot),
        completed: true,
      });
    }
  }

  items(): HostItemSnapshot[] {
    return structuredClone(
      [...this.#items.values()]
        .filter(
          ({ snapshot, completed }) =>
            completed ||
            snapshot.item.type === "agentMessage" ||
            snapshot.item.type === "reasoning",
        )
        .map(({ snapshot }) => snapshot),
    );
  }
}
