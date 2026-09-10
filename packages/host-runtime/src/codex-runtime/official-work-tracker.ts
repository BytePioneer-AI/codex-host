import type { JsonObject } from "@codexhost/protocol-core";

import type { OfficialWorkGate } from "./official-work-gate.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const key = (client: string, kind: string, id: unknown): string =>
  JSON.stringify([client, kind, id]);

/** Native work outlives RPC responses. Input is restricted to the owner's live generation. */
export class OfficialWorkTracker {
  readonly #gate: OfficialWorkGate;
  readonly #completed = new Set<string>();
  readonly #shells = new Map<string, number>();
  readonly #completedShells = new Set<string>();
  readonly #revisions = new Map<string, number>();
  readonly #inspectQueue: (client: string, threadId: string) => void;
  constructor(gate: OfficialWorkGate, inspectQueue: (client: string, threadId: string) => void) {
    this.#gate = gate;
    this.#inspectQueue = inspectQueue;
  }

  admitted(client: string, method: string, params: JsonObject): (response: JsonObject) => void {
    const sustained =
      method === "process/spawn"
        ? key(client, "process", params.processHandle)
        : method === "thread/realtime/start"
          ? key(client, "realtime", params.threadId)
          : method === "thread/compact/start"
            ? key(client, "compact", params.threadId)
            : method === "mcpServer/oauth/login"
              ? key(client, "oauth", params.name)
              : undefined;
    const alreadyActive = sustained ? this.#gate.nativeWork(sustained, true) : false;
    if (method === "thread/shellCommand") this.#shell(params.threadId, 1);
    const queueKey = key(client, "queue", params.threadId);
    const goalKey = key(client, "goal", params.threadId);
    const revisionKey = method.startsWith("thread/queue/") ? queueKey : goalKey;
    if (
      (method.startsWith("thread/queue/") && method !== "thread/queue/list") ||
      method === "thread/goal/set" ||
      method === "thread/goal/clear"
    )
      this.#bump(revisionKey);
    const revision = this.#revisions.get(revisionKey);
    let settled = false;
    return (response) => {
      if (settled) return;
      settled = true;
      if (response.error) {
        if (method === "thread/shellCommand") this.#shell(params.threadId, -1);
        // A failed duplicate spawn must not release the existing process's busy marker.
        if (sustained && !alreadyActive) this.#gate.nativeWork(sustained, false);
        return;
      }
      const startsTurn = method === "turn/start" || method === "thread/queue/start";
      if (startsTurn && (!object(response.result) || !object(response.result.turn)))
        this.#gate.nativeWork(key(client, "unconfirmed-start", params.threadId), true);
      if (!object(response.result)) return;
      const result = response.result;
      if (startsTurn && object(result.turn)) this.#turn(client, params.threadId, result.turn);
      if (
        object(result.thread) &&
        object(result.thread.status) &&
        result.thread.status.type === "active"
      ) {
        this.#gate.nativeWork(key(client, "thread-status", result.thread.id), true);
      }
      if (revision !== this.#revisions.get(revisionKey)) return;
      if (method === "thread/queue/list" && typeof params.threadId === "string") {
        if (params.cursor == null) {
          this.#gate.nativeWork(
            queueKey,
            !Array.isArray(result.data) || result.data.length > 0 || result.nextCursor !== null,
          );
        }
      }
      if (
        method.startsWith("thread/queue/") &&
        method !== "thread/queue/list" &&
        typeof params.threadId === "string"
      ) {
        this.#gate.nativeWork(queueKey, true);
        this.#inspectQueue(client, params.threadId);
      }
      if (["thread/goal/set", "thread/goal/get", "thread/goal/clear"].includes(method)) {
        this.#gate.nativeWork(
          goalKey,
          method !== "thread/goal/clear" &&
            result.goal !== null &&
            (!object(result.goal) || result.goal.status !== "complete"),
        );
      }
    };
  }

  notification(client: string, value: JsonObject): void {
    if (typeof value.method !== "string" || !object(value.params)) return;
    const params = value.params;
    const method = value.method;
    if ((method === "turn/started" || method === "turn/completed") && object(params.turn)) {
      const id = key(client, "turn", [params.threadId, params.turn.id]);
      if (method === "turn/completed") {
        this.#completed.add(id);
        if (this.#completed.size > 2_048)
          this.#completed.delete(this.#completed.values().next().value ?? "");
        this.#gate.nativeWork(id, false);
      } else if (!this.#completed.has(id)) this.#gate.nativeWork(id, true);
    }
    if (
      method === "item/completed" &&
      object(params.item) &&
      params.item.type === "commandExecution" &&
      params.item.source === "userShell" &&
      typeof params.item.id === "string"
    ) {
      const completed = key("", "shell-item", [params.threadId, params.item.id]);
      if (!this.#completedShells.has(completed)) {
        // Terminal notifications can be broadcast to several native clients.
        // Count accepted work globally; do not guess which identical command
        // belongs to which connection or clear all commands on one completion.
        if (this.#completedShells.size >= 65_536) {
          this.#gate.nativeWork(key("", "shell-tracking-limit", null), true);
          return;
        }
        this.#completedShells.add(completed);
        this.#shell(params.threadId, -1);
      }
    }
    if (method === "thread/status/changed" && object(params.status)) {
      // Per-connection notifications are ordered. A systemError is not proof of idle.
      this.#gate.nativeWork(
        key(client, "thread-status", params.threadId),
        !["idle", "notLoaded"].includes(String(params.status.type)),
      );
    }
    if (method === "thread/realtime/started")
      this.#gate.nativeWork(key(client, "realtime", params.threadId), true);
    if (method === "thread/realtime/closed")
      this.#gate.nativeWork(key(client, "realtime", params.threadId), false);
    if (method === "process/exited")
      this.#gate.nativeWork(key(client, "process", params.processHandle), false);
    if (method === "thread/compacted")
      this.#gate.nativeWork(key(client, "compact", params.threadId), false);
    if (method === "mcpServer/oauthLogin/completed")
      this.#gate.nativeWork(key(client, "oauth", params.name), false);
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      const goalKey = key(client, "goal", params.threadId);
      this.#bump(goalKey);
      this.#gate.nativeWork(
        goalKey,
        method !== "thread/goal/cleared" &&
          (!object(params.goal) || params.goal.status !== "complete"),
      );
    }
    if (method === "thread/queue/changed" && typeof params.threadId === "string") {
      const queueKey = key(client, "queue", params.threadId);
      this.#bump(queueKey);
      this.#gate.nativeWork(queueKey, true);
      this.#inspectQueue(client, params.threadId);
    }
  }

  retired(): void {
    this.#completed.clear();
    this.#revisions.clear();
    this.#shells.clear();
    this.#completedShells.clear();
  }
  #shell(threadId: unknown, delta: number): void {
    const id = key("", "user-shell", threadId);
    const count = (this.#shells.get(id) ?? 0) + delta;
    this.#shells.set(id, Math.max(0, count));
    // Underflow is an uncorrelated native terminal, not a credit for future work.
    if (count < 0) this.#gate.nativeWork(key("", "uncorrelated-shell", threadId), true);
    this.#gate.nativeWork(id, count > 0);
  }
  #bump(id: string): void {
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
  }
  #turn(client: string, thread: unknown, turn: JsonObject): void {
    const id = key(client, "turn", [thread, turn.id]);
    if (this.#completed.has(id)) return;
    this.#gate.nativeWork(
      id,
      !["completed", "interrupted", "failed"].includes(String(turn.status)),
    );
  }
}
