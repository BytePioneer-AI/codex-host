/** Native operations use command cards, never synthetic conversation Turns. */
import type { ClientSubmission, ClientThreadSnapshot } from "@codexhost/shared-contracts";
import type { ChTurn } from "./ch-thread-view.ts";
import type { SessionLog } from "./session-log.ts";

type Command = NonNullable<ClientThreadSnapshot["command"]>;

export class ChCommandPresentation {
  private readonly commands = new Map<string, boolean>();
  private compacting: boolean | undefined;

  constructor(private readonly log: SessionLog) {}

  update(
    command: Command | undefined,
    turns: readonly ChTurn[],
    submissions: readonly ClientSubmission[] = [],
  ): void {
    const operations = new Map<string, Command>();
    for (const submission of submissions)
      if (submission.operation) operations.set(submission.operation.turn.id, submission.operation);
    if (command) operations.set(command.turn.id, command);
    const compactingTurns = [...turns, ...[...operations.values()].map((entry) => entry.turn)];
    const compacting =
      [...operations.values()].some(
        (entry) => entry.name === "compact" && entry.turn.status === "inProgress",
      ) ||
      compactingTurns.some(
        (turn) =>
          (turn.status === "inProgress" || turn.status === "running") &&
          turn.items.some(
            (item) =>
              item.type === "contextCompaction" &&
              (item.status === "inProgress" || item.status === "running"),
          ),
      );
    if (compacting !== this.compacting) {
      this.log.setProjection("compacting", compacting);
      this.compacting = compacting;
    }
    if (command) {
      for (const [id, done] of this.commands) {
        if (done || operations.has(id)) continue;
        this.log.append("command/done", {
          commandId: id,
          kind: "error",
          text: "The Host no longer reports the outcome of this command.",
        });
        this.commands.set(id, true);
      }
    }
    for (const operation of operations.values()) this.updateOperation(operation);
  }

  private updateOperation({ turn, name }: Command): void {
    if (!this.commands.has(turn.id)) {
      this.log.append("command/run", { commandId: turn.id, name, source: { kind: "user" } });
      this.commands.set(turn.id, false);
    }
    if (turn.status === "inProgress" || this.commands.get(turn.id)) return;
    const success = turn.status === "completed";
    const text = success
      ? turn.items
          .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n") || undefined
      : (turn.error?.message ??
        (turn.status === "interrupted" ? "Command cancelled." : "Command failed."));
    this.log.append("command/done", {
      commandId: turn.id,
      kind: success ? "success" : "error",
      ...(text === undefined ? {} : { text }),
    });
    this.commands.set(turn.id, true);
  }
}
