/** Ephemeral Host commands use command cards, never synthetic conversation Turns. */
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import type { ChTurn } from "./ch-thread-view.ts";
import type { SessionLog } from "./session-log.ts";

export class ChCommandPresentation {
  private current: { id: string; done: boolean } | undefined;
  private compacting: boolean | undefined;

  constructor(private readonly log: SessionLog) {}

  update(command: ClientThreadSnapshot["command"], turns: readonly ChTurn[]): void {
    const commandRunning = command?.turn.status === "inProgress";
    const compactingTurns = command ? [...turns, command.turn] : turns;
    const compacting =
      (command?.name === "compact" && commandRunning) ||
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
    if (!command) return;
    const { turn, name } = command;
    if (this.current?.id !== turn.id) {
      if (this.current && !this.current.done)
        this.log.append("command/done", {
          commandId: this.current.id,
          kind: "error",
          text: "The Host no longer reports the outcome of this command.",
        });
      this.log.append("command/run", {
        commandId: turn.id,
        name,
        source: { kind: "user" },
      });
      this.current = { id: turn.id, done: false };
    }
    if (commandRunning || this.current.done) return;
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
    this.current.done = true;
  }
}
