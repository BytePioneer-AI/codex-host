import type { HostItemOutcome } from "@codexhost/harness-adapter";
import { record, TraeError } from "./errors.js";

const BACKGROUND_STATUSES = new Set([
  "runningskipped",
  "running_skipped",
  "running_in_background",
  "timed_out_moved_to_background",
  "manually_backgrounded",
  "background",
]);

/** Native launch/transfer success is not the command's eventual outcome. */
export function assertObservedCommand(
  params: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  confirmation: unknown,
  terminal?: HostItemOutcome,
): void {
  const data = record(result?.data) ? result.data : undefined;
  const status = typeof data?.status === "string" ? data.status.toLowerCase() : undefined;
  const background =
    params.blocking === false ||
    data?.is_background === true ||
    (typeof data?.run_command_to_bg_reason === "string" && !!data.run_command_to_bg_reason) ||
    (typeof data?.runCommandToBgReason === "string" && !!data.runCommandToBgReason) ||
    (status !== undefined && BACKGROUND_STATUSES.has(status)) ||
    result?.status === "skipped_run" ||
    (record(confirmation) && confirmation.confirm_status === "skipped_run");
  const running = result?.status === "running" || status === "running";
  if (background || (running && (result?.status === "success" || terminal?.status === "succeeded")))
    throw new TraeError(
      "unsupported",
      "TRAE CN background command completion is not observed; native work may still be running",
    );
}
