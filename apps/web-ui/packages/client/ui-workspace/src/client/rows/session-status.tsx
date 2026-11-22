/** Shared row status presentation; callers decide whether completion reminders belong on their surface. */
import { StateDot, type StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import type { SessionNode } from "../tree.ts";
import css from "./Rows.module.css";

type RowTranslate = WorkspaceBrowserProps["t"];

interface SessionStatus {
  state: StateDotState;
  label: string;
  trailingLabel?: string;
}

/** Pending interaction is primary; live activity outranks completion reminders. */
export function sessionStatuses(
  node: Pick<SessionNode, "pendingInteraction" | "running" | "runningSubagentCount" | "completed">,
  t: RowTranslate,
): readonly [SessionStatus, ...SessionStatus[]] {
  const subagents: SessionStatus | undefined =
    node.runningSubagentCount === 0
      ? undefined
      : {
          state: "ongoing",
          label: t(
            node.runningSubagentCount === 1
              ? "status.subagentsRunning.one"
              : "status.subagentsRunning.other",
            { n: node.runningSubagentCount },
          ),
        };
  let pending: SessionStatus | undefined;
  switch (node.pendingInteraction) {
    case "approval":
      pending = {
        state: "warning",
        label: t("status.waitingApproval"),
        trailingLabel: t("status.compact.approval"),
      };
      break;
    case "plan-review":
      pending = {
        state: "warning",
        label: t("status.planReview"),
        trailingLabel: t("status.compact.planReview"),
      };
      break;
    case "question":
      pending = {
        state: "warning",
        label: t("status.waitingAnswer"),
        trailingLabel: t("status.compact.answer"),
      };
      break;
    case undefined:
      break;
    default:
      return assertNever(node.pendingInteraction);
  }
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents];
  if (node.running) {
    const primary: SessionStatus = { state: "ongoing", label: t("status.running") };
    return subagents === undefined ? [primary] : [primary, subagents];
  }
  if (subagents !== undefined) return [subagents];
  if (node.completed) return [{ state: "done", label: t("status.completed") }];
  return [{ state: "idle", label: t("status.idle") }];
}

function assertNever(value: never): never {
  throw new Error(`unknown pending interaction: ${String(value)}`);
}

/** Primary real status glyph and accessible labels, without a second visible text row. */
export function SessionStatusDots({
  statuses,
}: {
  statuses: readonly [SessionStatus, ...SessionStatus[]];
}) {
  return (
    <>
      <StateDot state={statuses[0].state} size={statuses[0].state === "ongoing" ? 16 : undefined} />
      {statuses.map((status) => (
        <span className={css.visuallyHidden} key={status.label}>
          {status.label}
        </span>
      ))}
    </>
  );
}
