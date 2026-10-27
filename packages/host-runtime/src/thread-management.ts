import path from "node:path";
import { transportModelIdForHarness, type ExternalHarnessId } from "@codexhost/protocol-core";
import type {
  ThreadManagementOperation,
  ThreadManagementResult,
} from "@codexhost/shared-contracts";
import type { ConsoleHostReply } from "./app-server-host.js";
import { DelegationControlError } from "./delegation-types.js";

/** Lifecycle operations use the same native and external Thread handlers as Desktop. */
export async function manageThread(
  action: ThreadManagementOperation,
  request: (method: string, params: Record<string, unknown>) => Promise<ConsoleHostReply>,
): Promise<ThreadManagementResult> {
  if (action.operation === "create" && !path.isAbsolute(action.cwd))
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--cwd must be an absolute path on the target machine",
    );
  const method = {
    create: "thread/start",
    rename: "thread/name/set",
    archive: "thread/archive",
    unarchive: "thread/unarchive",
    delete: "thread/delete",
  }[action.operation];
  const params =
    action.operation === "create"
      ? {
          cwd: action.cwd,
          ephemeral: false,
          ...(action.harnessId === "codex"
            ? { historyMode: "legacy" }
            : { model: transportModelIdForHarness(action.harnessId as ExternalHarnessId) }),
        }
      : {
          threadId: action.threadId,
          ...(action.operation === "rename" ? { name: action.name } : {}),
        };
  const response = await request(method, params);
  if ("error" in response) {
    if ([-32093, -32001, -32603].includes(response.error.code))
      throw new DelegationControlError(
        "OUTCOME_UNKNOWN",
        "Thread operation timed out; recover with the same request ID",
      );
    throw new DelegationControlError("DELEGATION_FAILED", response.error.message, {
      notStarted: true,
    });
  }
  if (action.operation !== "create")
    return { operation: action.operation, threadId: action.threadId };
  const result = response.result;
  const thread =
    result && typeof result === "object" && !Array.isArray(result) ? result.thread : undefined;
  if (
    !thread ||
    typeof thread !== "object" ||
    Array.isArray(thread) ||
    typeof thread.id !== "string" ||
    !thread.id
  )
    throw new DelegationControlError(
      "OUTCOME_UNKNOWN",
      "Thread creation returned no identity; recover with the same request ID",
    );
  return { operation: "create", threadId: thread.id };
}
