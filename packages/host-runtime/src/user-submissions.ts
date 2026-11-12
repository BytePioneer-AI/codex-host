import {
  clientCommandSnapshotSchema,
  type ClientSubmission,
  type HostTurnId,
} from "@codexhost/shared-contracts";

/** Process-local confirmations, not a transcript or durable execution journal. */
export class UserSubmissions {
  readonly #entries = new Map<string, ClientSubmission>();
  readonly #inputs = new Map<string, string>();

  accept(clientUserMessageId: string | undefined, turnId: HostTurnId, text?: string): void {
    if (!clientUserMessageId) return;
    if (this.#entries.size >= 256 && !this.#entries.has(clientUserMessageId)) {
      const terminal = [...this.#entries].find(
        ([, entry]) => entry.status !== "accepted" && entry.status !== "running",
      );
      if (terminal) {
        this.#entries.delete(terminal[0]);
        this.#inputs.delete(terminal[0]);
      }
    }
    if (text !== undefined) this.#inputs.set(clientUserMessageId, text);
    this.#entries.set(clientUserMessageId, {
      clientUserMessageId,
      turnId,
      status: "accepted",
      execution: "pending",
    });
  }

  started(turnId: HostTurnId, ephemeral: boolean): void {
    this.#update(turnId, {
      status: "running",
      execution: ephemeral ? "operation" : "conversation",
    });
  }

  finish(
    turnId: HostTurnId,
    status: "completed" | "failed" | "cancelled" | "rejected",
    error?: string,
  ): void {
    this.#update(turnId, { status, ...(error ? { error } : {}) });
  }

  input(turnId: string, clientId?: unknown): string | undefined {
    for (const [id, entry] of this.#entries)
      if (entry.turnId === turnId && (clientId === undefined || clientId === id))
        return this.#inputs.get(id);
    return undefined;
  }

  operation(turnId: HostTurnId, name: string, turn: unknown): void {
    this.#update(turnId, { operation: clientCommandSnapshotSchema.parse({ name, turn }) });
  }

  snapshot(activeTurn?: unknown): ClientSubmission[] {
    return [...this.#entries.values()].map((entry) => ({
      ...entry,
      ...(entry.operation && entry.status === "running" && activeTurn
        ? {
            operation: clientCommandSnapshotSchema.parse({
              name: entry.operation.name,
              turn: activeTurn,
            }),
          }
        : {}),
    }));
  }

  #update(turnId: HostTurnId, update: Partial<ClientSubmission>): void {
    for (const [id, entry] of this.#entries)
      if (entry.turnId === turnId) this.#entries.set(id, { ...entry, ...update });
  }
}
