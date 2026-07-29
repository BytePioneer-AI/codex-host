import { randomUUID } from "node:crypto";
import path from "node:path";

import { summarizeNativeMessages } from "./terminal.mjs";
import { closeQuery, withTimeout } from "./runtime.mjs";
import { writeLocalJson } from "./workspace.mjs";

export class PushableInput {
  #closed = false;
  #queue = [];
  #waiters = [];

  push(value) {
    if (this.#closed) throw new Error("Claude Probe input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#queue.push(value);
  }

  end() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export function sdkUserMessage(sessionId, text, uuid = randomUUID()) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
    origin: { kind: "human" },
  };
}

export async function collectTurn(activeQuery, { cancelRequested = false } = {}) {
  const messages = [];
  for (;;) {
    const next = await withTimeout(activeQuery.next(), 90_000, "Claude Turn result");
    if (next.done) throw new Error("Claude Query ended before a Turn result");
    messages.push(next.value);
    if (next.value.type === "result") break;
  }
  return {
    messages,
    summary: summarizeNativeMessages(messages, { cancelRequested }),
  };
}

export async function collectQuery(activeQuery, options) {
  const messages = [];
  try {
    for (;;) {
      const next = await withTimeout(activeQuery.next(), 90_000, "Claude Query result");
      if (next.done) break;
      messages.push(next.value);
    }
  } finally {
    await closeQuery(activeQuery);
  }
  return { messages, summary: summarizeNativeMessages(messages, options) };
}

export function nativeIds(messages) {
  return messages.flatMap((message) => (typeof message?.uuid === "string" ? [message.uuid] : []));
}

export function allSessionsMatch(messages, expected) {
  const observed = messages.flatMap((message) =>
    typeof message?.session_id === "string" ? [message.session_id] : [],
  );
  return observed.length > 0 && observed.every((sessionId) => sessionId === expected);
}

export function nativeToolUses(messages) {
  return messages.flatMap((message) => {
    if (message?.type !== "assistant" || !Array.isArray(message.message?.content)) return [];
    return message.message.content.flatMap((block) =>
      block?.type === "tool_use" && typeof block.id === "string"
        ? [{ id: block.id, name: block.name, input: block.input }]
        : [],
    );
  });
}

export function nativeToolResults(messages) {
  return messages.flatMap((message) => {
    if (message?.type !== "user") return [];
    const ids = [];
    if (typeof message.parent_tool_use_id === "string") ids.push(message.parent_tool_use_id);
    if (Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          ids.push(block.tool_use_id);
        }
      }
    }
    return ids.map((id) => ({ id, value: message.tool_use_result }));
  });
}

export function writeRawScenario(repositoryRoot, workspace, scenario, value) {
  return writeLocalJson(repositoryRoot, path.join(workspace.raw, `${scenario}.local.json`), value);
}
