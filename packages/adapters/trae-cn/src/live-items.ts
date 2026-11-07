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
import { type NativeBackgroundCommand, type NativeCommandStatus } from "./commands.js";

interface LiveItem {
  item: HostItem;
  outcome?: HostItemOutcome;
  detached?: boolean;
  background?: NativeBackgroundCommand;
}

/** Projects cumulative native plan updates into ordered public Item lifecycles. */
export class LiveItems {
  #items = new Map<string, LiveItem>();
  constructor(
    private readonly turnId: HostTurnId,
    private readonly emit: (event: HostEvent) => void,
    private readonly background?: {
      follow(ref: NativeBackgroundCommand, update: (status: NativeCommandStatus) => void): void;
    },
  ) {}

  acceptPlan(value: unknown): void {
    for (const projected of projectPlanItem(value, undefined, undefined, !!this.background))
      this.#accept(projected);
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
      if (
        previous.background &&
        next.background &&
        !isDeepStrictEqual(previous.background, next.background)
      )
        throw new TraeError("protocolError", "Native background execution changed identity");
      if (previous.outcome) {
        if (
          previous.detached &&
          next.background &&
          previous.background &&
          isDeepStrictEqual(previous.background, next.background) &&
          previous.item.type === "commandExecution" &&
          next.item.type === "commandExecution" &&
          previous.item.command === next.item.command &&
          previous.item.cwd === next.item.cwd
        )
          return;
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
      this.#items.set(id, {
        ...next,
        ...(previous.detached ? { detached: true } : {}),
        ...(previous.background ? { background: previous.background } : {}),
      });
    }
    const current = this.#items.get(id);
    if (next.background && current && !current.detached && !current.outcome) {
      this.background?.follow(next.background, (status) => this.#backgroundStatus(id, status));
      current.detached = true;
      this.emit({ type: "item.detached", turnId: this.turnId, itemId: id });
    }
    if (next.outcome)
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: next.item, outcome: next.outcome },
      });
  }

  get hasDetachedWork(): boolean {
    return [...this.#items.values()].some((item) => item.detached && !item.outcome);
  }

  #backgroundStatus(id: string, status: NativeCommandStatus): void {
    const current = this.#items.get(id);
    if (!current || current.item.type !== "commandExecution" || current.outcome) return;
    const outcome: HostItemOutcome | undefined =
      status.status === "running"
        ? undefined
        : status.status === "succeeded"
          ? { status: "succeeded" }
          : status.status === "cancelled"
            ? { status: "cancelled", reason: "Native background command stopped" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: "Native background command failed",
                  retryable: false,
                },
              };
    this.#accept({
      item: {
        ...current.item,
        output: status.output,
        outputTruncated: status.outputTruncated,
        ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      },
      ...(outcome ? { outcome } : {}),
    });
  }

  /** Publish exact message-snapshot diffs after durable native completion. */
  acceptFileChanges(items: readonly HostItemSnapshot[]): void {
    for (const snapshot of items) if (snapshot.item.type === "fileChange") this.#accept(snapshot);
  }

  /** Native terminal/history evidence settles open Items; EOF alone must never call this. */
  settle(outcome: HostItemOutcome, includeDetached = false): void {
    for (const item of this.#items.values()) {
      if (item.outcome || (item.detached && !includeDetached)) continue;
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
