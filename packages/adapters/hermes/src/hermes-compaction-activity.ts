import { randomUUID } from "node:crypto";
import type { HostAgentMessageItem, HostItemSnapshot } from "@codexhost/harness-adapter";
import { hostItemIdSchema } from "@codexhost/shared-contracts";

/** Native phase observation, not a commit: `compacted` is also emitted on abort paths. */
export class HermesCompactionActivity {
  #item: HostAgentMessageItem | null = null;
  start(text: string): HostAgentMessageItem | null {
    if (this.#item) return null; // heartbeats are not new attempts
    this.#item = {
      type: "agentMessage",
      itemId: hostItemIdSchema.parse(randomUUID()),
      phase: "commentary",
      text: `Hermes 自动压缩：${text || "进行中"}`,
    };
    return this.#item;
  }
  appendNotice(text: string): { itemId: HostAgentMessageItem["itemId"]; text: string } | null {
    if (!this.#item || !text) return null;
    const addition = `\nHermes 提示：${text}`;
    this.#item = { ...this.#item, text: this.#item.text + addition };
    return { itemId: this.#item.itemId, text: addition };
  }
  finish(reason: string): HostItemSnapshot | null {
    if (!this.#item) return null;
    const item = { ...this.#item, text: `${this.#item.text}\n${reason}` };
    this.#item = null;
    // Complete a commentary message, not a contextCompaction Item. The official
    // wire Item has no outcome field to represent an unconfirmed commit.
    return { item, outcome: { status: "succeeded" } };
  }
}
