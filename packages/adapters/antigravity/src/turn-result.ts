import { isRecord, type AntigravityResultEvent } from "./stream-events.js";

/** Confirm an old cascade error without treating a partial response as success. */
export function hasHistoricalAntigravityError(
  value: unknown,
  result: AntigravityResultEvent["result"],
  completedResponseStep: number | null,
): boolean {
  if (
    result.status !== "ERROR" ||
    result.error?.trim() ||
    !result.response?.trim() ||
    completedResponseStep === null ||
    !isRecord(value) ||
    value.status !== "CASCADE_RUN_STATUS_IDLE" ||
    !isRecord(value.trajectory) ||
    value.trajectory.cascadeId !== result.conversation_id ||
    !Array.isArray(value.trajectory.steps)
  )
    return false;
  const steps = value.trajectory.steps;
  if (!steps.every(isRecord) || completedResponseStep !== steps.length - 1) return false;
  const starts = steps.flatMap((step, index) =>
    step.type === "CORTEX_STEP_TYPE_USER_INPUT" ? [index] : [],
  );
  const start = starts.at(-1);
  if (start === undefined || starts.length < 2 || starts.length !== result.num_turns) return false;
  const current = steps.slice(start);
  return (
    steps.slice(0, start).some((step) => step.type === "CORTEX_STEP_TYPE_ERROR") &&
    current.every(
      (step) =>
        step.status === "CORTEX_STEP_STATUS_DONE" &&
        step.type !== "CORTEX_STEP_TYPE_ERROR" &&
        step.errorDetails == null,
    ) &&
    current.at(-1)?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE"
  );
}
