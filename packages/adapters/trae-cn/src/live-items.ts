import type {
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
} from "@codexhost/harness-adapter";
import type { HostTurnId } from "@codexhost/shared-contracts";
import { isDeepStrictEqual } from "node:util";
import { TraeError } from "./errors.js";
import { projectPlanItem, type ProjectedPlanItem } from "./history.js";

interface LiveItem {
  item: HostItem;
  outcome?: HostItemOutcome;
}

/** Projects cumulative native plan updates into ordered public Item lifecycles. */
export class LiveItems {
  #items = new Map<string, LiveItem>();
  constructor(
    private readonly turnId: HostTurnId,
    private readonly emit: (event: HostEvent) => void,
  ) {}

  acceptPlan(value: unknown): void {
    for (const projected of projectPlanItem(value)) this.#accept(projected);
  }

  #accept(next: ProjectedPlanItem): void {
    const id = next.item.itemId;
    const previous = this.#items.get(id);
    if (!previous) {
      this.#items.set(id, { ...next });
      this.emit({ type: "item.started", turnId: this.turnId, item: next.item });
    } else {
      if (previous.item.type !== next.item.type)
        throw new TraeError("protocolError", "Native plan Item changed its content type");
      if (previous.outcome) {
        if (
          !isDeepStrictEqual(previous.item, next.item) ||
          (next.outcome && !isDeepStrictEqual(previous.outcome, next.outcome))
        )
          throw new TraeError("protocolError", `Native plan Item changed after completion: ${id}`);
        return;
      }
      if (
        (previous.item.type === "agentMessage" || previous.item.type === "reasoning") &&
        (next.item.type === "agentMessage" || next.item.type === "reasoning")
      ) {
        if (!next.item.text.startsWith(previous.item.text))
          throw new TraeError(
            "protocolError",
            "Native cumulative text rewrote an already published prefix",
          );
        const text = next.item.text.slice(previous.item.text.length);
        if (text)
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: id,
            update: { type: "text.append", text },
          });
      } else if (
        previous.item.type === "commandExecution" &&
        next.item.type === "commandExecution"
      ) {
        if (
          previous.item.command !== next.item.command ||
          (previous.item.cwd && next.item.cwd && previous.item.cwd !== next.item.cwd)
        )
          throw new TraeError(
            "protocolError",
            "Native command changed its admitted command or directory",
          );
        if (!next.item.cwd && previous.item.cwd) next.item.cwd = previous.item.cwd;
        const before = previous.item.output ?? "";
        const after = next.item.output ?? before;
        if (!after.startsWith(before))
          throw new TraeError(
            "protocolError",
            "Native command output rewrote its published prefix",
          );
        if (after.length > before.length)
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: id,
            update: { type: "output.append", text: after.slice(before.length) },
          });
        if (next.item.output === undefined && previous.item.output !== undefined)
          next.item.output = previous.item.output;
      } else if (previous.item.type === "toolExecution" && next.item.type === "toolExecution") {
        if (
          previous.item.toolName !== next.item.toolName ||
          !isDeepStrictEqual(previous.item.arguments, next.item.arguments)
        )
          throw new TraeError("protocolError", "Native tool changed its admitted arguments");
        if (next.item.output && !isDeepStrictEqual(previous.item.output, next.item.output))
          this.emit({
            type: "item.updated",
            turnId: this.turnId,
            itemId: id,
            update: { type: "output.replace", output: next.item.output },
          });
      }
      this.#items.set(id, { ...next });
    }
    if (next.outcome)
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: next.item, outcome: next.outcome },
      });
  }

  /** Publish exact message-snapshot diffs after durable native completion. */
  acceptFileChanges(items: readonly HostItemSnapshot[]): void {
    for (const snapshot of items) if (snapshot.item.type === "fileChange") this.#accept(snapshot);
  }

  /** Native terminal/history evidence settles open Items; EOF alone must never call this. */
  settle(outcome: HostItemOutcome): void {
    for (const item of this.#items.values()) {
      if (item.outcome) continue;
      item.outcome = outcome;
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: item.item, outcome },
      });
    }
  }

  get snapshots(): HostItemSnapshot[] {
    return [...this.#items.values()].flatMap((entry) =>
      entry.outcome ? [{ item: entry.item, outcome: entry.outcome }] : [],
    );
  }
}
