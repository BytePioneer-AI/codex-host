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

export interface NativeCommandStatus {
  messageId: string;
  planItemId: string;
  commandId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  output: string;
  outputTruncated: boolean;
  exitCode?: number;
}

export interface NativeBackgroundCommand {
  messageId: string;
  planItemId: string;
  commandId: string;
}

export function hasBackgroundCommandHistory(
  value: unknown,
  retainedMessages?: Set<string>,
): boolean {
  return (
    record(value) &&
    Array.isArray(value.items) &&
    value.items.some(
      (item) =>
        record(item) &&
        (!retainedMessages ||
          (typeof item.reply_to_message_id === "string" &&
            retainedMessages.has(item.reply_to_message_id))) &&
        Array.isArray(item.commandStatuses) &&
        item.commandStatuses.length > 0,
    )
  );
}

export function isBackgroundCommand(
  params: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  confirmation: unknown,
): boolean {
  const data = record(result?.data) ? result.data : undefined;
  if (
    ["failed", "error", "skipped", "canceled", "cancelled"].includes(String(result?.status)) &&
    !data?.command_id
  )
    return false;
  const status = typeof data?.status === "string" ? data.status.toLowerCase() : undefined;
  return (
    params.blocking === false ||
    data?.is_background === true ||
    (typeof data?.run_command_to_bg_reason === "string" && !!data.run_command_to_bg_reason) ||
    (typeof data?.runCommandToBgReason === "string" && !!data.runCommandToBgReason) ||
    (status !== undefined && BACKGROUND_STATUSES.has(status)) ||
    result?.status === "skipped_run" ||
    (record(confirmation) && confirmation.confirm_status === "skipped_run")
  );
}

export function backgroundCommandReference(plan: Record<string, unknown>): NativeBackgroundCommand {
  const tool = record(plan.tool_call_info) ? plan.tool_call_info : undefined;
  const result = record(tool?.result) ? tool.result : undefined;
  const data = record(result?.data) ? result.data : undefined;
  if (
    ![plan.id, plan.reply_to_message_id, data?.command_id].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
    )
  )
    throw new TraeError(
      "unsupported",
      "Native background command has no stable execution identity",
    );
  return {
    messageId: plan.reply_to_message_id as string,
    planItemId: plan.id as string,
    commandId: data?.command_id as string,
  };
}

export function readCommandStatus(value: unknown): NativeCommandStatus {
  if (
    !record(value) ||
    ![value.messageId, value.planItemId, value.commandId].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
    ) ||
    !["running", "succeeded", "failed", "cancelled"].includes(String(value.status)) ||
    typeof value.output !== "string" ||
    value.output.length > 16384 ||
    typeof value.outputTruncated !== "boolean" ||
    (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) ||
    (value.status === "running" && value.exitCode !== undefined) ||
    (["succeeded", "failed"].includes(String(value.status)) && value.exitCode === undefined) ||
    (value.status === "succeeded" && value.exitCode !== 0)
  )
    throw new TraeError("protocolError", "Invalid observed native background command status");
  return value as unknown as NativeCommandStatus;
}

/** Native launch/transfer success is not the command's eventual outcome. */
export function assertObservedCommand(
  params: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  confirmation: unknown,
  terminal?: HostItemOutcome,
  observed?: NativeCommandStatus,
): void {
  if (observed?.status === "running")
    throw new TraeError("sessionBusy", "The native background command is still running");
  if (observed) return;
  const data = record(result?.data) ? result.data : undefined;
  const status = typeof data?.status === "string" ? data.status.toLowerCase() : undefined;
  const background = isBackgroundCommand(params, result, confirmation);
  const running = result?.status === "running" || status === "running";
  if (background || (running && (result?.status === "success" || terminal?.status === "succeeded")))
    throw new TraeError(
      "unsupported",
      "TRAE CN background command completion is not observed; native work may still be running",
    );
}
