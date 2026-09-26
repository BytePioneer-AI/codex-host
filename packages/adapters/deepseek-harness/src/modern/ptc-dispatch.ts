import type {
  HostItemOutcome,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import { jsonValueSchema, type HostItemId } from "@codexhost/shared-contracts";

import type { DeepSeekModernProfile } from "../profiles/profile.js";
import { contentText } from "../projection.js";
import { redactModernCredential } from "./wire.js";

/**
 * DSH PTC mode runs a `run_code` program whose nested Tool calls are recorded
 * only as `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events. They never
 * enter model context, and the enclosing `run_code` result carries only the
 * program's curated output, yet each one is a real native Tool execution. For
 * V4 (DSH 0.1.7+), every dispatch becomes its own Host Tool Item, so Desktop
 * renders it exactly like a direct call of the same Tool, and the `run_code`
 * call itself projects no Item: Desktop has no carrier for its program source,
 * and each Tool it dispatched is already shown. Earlier formats keep showing
 * `run_code` as one Generic Tool.
 */

export function projectsPtcDispatches(profile: DeepSeekModernProfile): boolean {
  return profile.sessionFormatVersion === 4;
}

export function isPtcProgramTool(profile: DeepSeekModernProfile, toolName: string): boolean {
  return projectsPtcDispatches(profile) && toolName === "run_code";
}

/** Open-Tool key, prefixed so a sub-call can never collide with a native callId. */
export function ptcDispatchKey(data: Readonly<Record<string, unknown>>): string {
  return `dispatch:${data.subCallId as string}`;
}

export function ptcDispatchItem(
  itemId: HostItemId,
  data: Readonly<Record<string, unknown>>,
): HostToolExecutionItem {
  // DSH logs JSON-normalized arguments; the validator admits any JSON value.
  const parsed = jsonValueSchema.safeParse(data.arguments);
  return {
    type: "toolExecution",
    itemId,
    toolName: data.name as string,
    arguments: parsed.success ? parsed.data : {},
  };
}

export function ptcDispatchOutput(
  data: Readonly<Record<string, unknown>>,
  limit: number,
): HostToolOutput | undefined {
  const text = contentText(data);
  if (!text) return undefined;
  const truncated = text.length > limit;
  return {
    content: [{ type: "text", text: truncated ? text.slice(0, limit) : text }],
    ...(truncated ? { truncated: true } : {}),
  };
}

export function ptcDispatchOutcome(
  data: Readonly<Record<string, unknown>>,
  toolName: string,
): HostItemOutcome {
  if (data.isError !== true && data.error === undefined) return { status: "succeeded" };
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: redactModernCredential(`DeepSeek Harness Tool '${toolName}' failed`),
      retryable: false,
    },
  };
}
