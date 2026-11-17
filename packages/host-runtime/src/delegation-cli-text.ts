import type { DelegationCliCommand } from "./delegation-cli-help.js";
import { compactDelegationOutput } from "./delegation-cli-output.js";
import { DelegationControlError, type DelegationThreadSnapshot } from "./delegation-types.js";

/** Flatten compact fields without JSON quoting or string escaping. */
function fields(value: unknown, prefix = ""): string[] {
  if (value === undefined) return [];
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}: ${Array.isArray(value) ? "[]" : "{}"}`];
    return entries.flatMap(([key, item]) => fields(item, prefix ? `${prefix}.${key}` : key));
  }
  return [`${prefix}: ${String(value)}`];
}

function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/gu, " ");
}

function snapshotText(
  snapshot: DelegationThreadSnapshot & { timedOut?: boolean },
  view: "result" | "messages",
): string {
  const compact = compactDelegationOutput("thread read", snapshot, view) as Record<string, unknown>;
  const header = [
    `thread: ${compact.thread}   harness: ${snapshot.harnessId}   status: ${snapshot.status}`,
    ...(snapshot.turn ? [`turn: ${snapshot.turn.turnId}   status: ${snapshot.turn.status}`] : []),
    ...(view === "result" && snapshot.status === "running"
      ? fields(snapshot.progress.filter(({ text }) => text.trim()).at(-1)?.text, "progress").map(
          singleLine,
        )
      : []),
    ...fields(compact.timedOut, "timedOut"),
    ...fields(compact.pendingQuestions, "pendingQuestions"),
  ];
  if (view === "messages") {
    const overview = `totalTurns: ${snapshot.totalTurns}   from: ${snapshot.from}   to: ${snapshot.to}`;
    header.push(...fields(compact.error, "error"));
    const turns = (snapshot.turns ?? []).map(({ turnNumber, status, messages }) =>
      [
        `#${turnNumber} ${status}`,
        ...messages.map(
          ({ role, phase, text }) => `role: ${role}${phase ? `   phase: ${phase}` : ""}\n${text}`,
        ),
      ].join("\n\n"),
    );
    return `${overview}\n${header.join("\n")}\n---\n${turns.join("\n\n")}`;
  }
  header.push(
    ...fields(snapshot.result.availability, "availability"),
    ...fields(snapshot.result.message, "error"),
  );
  return `${header.join("\n")}\n---\n${snapshot.result.text ?? ""}`;
}

/** Explicitly scoped so a new command cannot silently fall back to JSON. */
export function assertDelegationTextCommand(command: string): void {
  switch (command) {
    case "host info":
    case "project list":
    case "thread file":
    case "thread export":
    case "harness list":
    case "harness inspect":
    case "delegate start":
    case "thread send":
    case "thread cancel":
    case "thread read":
    case "thread wait":
    case "thread watch":
    case "thread watches":
    case "thread list":
      return;
    default:
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `--format text is not supported for '${command}'`,
      );
  }
}

export function textDelegationOutput(
  command: DelegationCliCommand,
  body: unknown,
  view: "result" | "messages" = "result",
): string {
  assertDelegationTextCommand(command);
  if (command === "thread read" || command === "thread wait")
    return snapshotText(body as DelegationThreadSnapshot, view);
  const compact = compactDelegationOutput(command, body, view);
  if (command === "thread watches") {
    const { watches } = compact as { watches: unknown[] };
    // Watch metadata is kept on one physical line; Thread bodies use snapshotText verbatim.
    return watches.map((watch) => fields(watch).map(singleLine).join("   ")).join("\n");
  }
  return fields(compact).join("\n");
}
