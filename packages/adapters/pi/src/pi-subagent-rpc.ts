import { randomUUID } from "node:crypto";

import {
  parsePiSubagentId,
  parsePiSubagentInspection,
  parsePiSubagentStatus,
  type PiSubagentInspection,
  type PiSubagentNode,
} from "./pi-subagents.js";

/** Side-channel extension widgets are independent of Pi's model Turn lifecycle. */
export class PiSubagentRpc {
  #handler: ((runs: PiSubagentNode[]) => void) | undefined;
  #latest: PiSubagentNode[] | undefined;
  readonly #pending = new Map<
    string,
    {
      resolve(reply: PiSubagentInspection): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly send: (
      type: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
    private readonly timeoutMs: number,
  ) {}

  setHandler(handler: (runs: PiSubagentNode[]) => void): void {
    this.#handler = handler;
    if (this.#latest) handler(this.#latest);
  }

  handle(value: Record<string, unknown>): boolean {
    if (
      value.type !== "extension_ui_request" ||
      value.method !== "setWidget" ||
      (value.widgetKey !== "subagent-async" && value.widgetKey !== "subagent-inspect")
    )
      return false;
    const status = parsePiSubagentStatus(value);
    if (status) {
      this.#latest = status;
      this.#handler?.(status);
    }
    const reply = parsePiSubagentInspection(value);
    if (reply) {
      const pending = this.#pending.get(reply.requestId);
      if (pending) {
        this.#pending.delete(reply.requestId);
        clearTimeout(pending.timer);
        pending.resolve(reply);
      }
    }
    // Malformed, unmatched, future-version and retract frames are never chat or questions.
    return true;
  }

  async inspect(nativeSubagentId: string): Promise<PiSubagentInspection> {
    const address = parsePiSubagentId(nativeSubagentId);
    const commands = await this.send("get_commands", {});
    const data = commands.data as { commands?: { name?: string; source?: string }[] } | undefined;
    if (
      !Array.isArray(data?.commands) ||
      !data.commands.some(
        (command) => command?.name === "subagents-inspect-rpc" && command.source === "extension",
      )
    ) {
      throw new Error("Installed Pi has no pi-subagents Host inspection command");
    }
    const requestId = randomUUID();
    const reply = new Promise<PiSubagentInspection>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("Pi subagent inspection timed out"));
      }, this.timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
    });
    try {
      const message = `/subagents-inspect-rpc ${requestId} ${address.runId}${address.childId ? ` ${address.childId}` : ""} --lines 200`;
      const [, result] = await Promise.all([this.send("prompt", { message }), reply]);
      if (
        !result.error &&
        ((result.asyncId !== address.runId && result.asyncId !== address.childId) ||
          result.childId !== address.childId)
      ) {
        throw new Error("Pi subagent inspection identity does not match the request");
      }
      return result;
    } finally {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
      }
    }
  }

  close(error = new Error("Pi subagent inspection transport closed")): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#handler = undefined;
  }
}
