import { randomUUID } from "node:crypto";
import {
  parseThreadReference,
  threadManagementInputSchema,
  type ThreadManagementInput,
} from "@codexhost/shared-contracts";
import { DelegationControlError } from "./delegation-types.js";

/** Parse only fixed lifecycle commands; arbitrary native RPC methods are not exposed. */
export function parseThreadManagementCommand(
  command: string | undefined,
  parsed: {
    positionals: string[];
    options: Map<string, string>;
  },
): ThreadManagementInput | null {
  if (!command || !["create", "rename", "archive", "unarchive", "delete"].includes(command))
    return null;
  const allowed =
    command === "create"
      ? ["--on", "--machine", "--cwd", "--harness"]
      : command === "rename"
        ? ["--name"]
        : command === "delete"
          ? ["--confirm"]
          : [];
  for (const key of parsed.options.keys())
    if (![...allowed, "--request-id", "--format"].includes(key))
      throw new DelegationControlError("INVALID_ARGUMENT", `Unknown option '${key}'`);
  const get = (key: string) => parsed.options.get(key);
  if (parsed.positionals.length !== (command === "create" ? 0 : 1))
    throw new DelegationControlError("INVALID_ARGUMENT", `Invalid arguments for thread ${command}`);
  if (command === "delete" && get("--confirm") !== "permanent")
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Permanent deletion requires --confirm permanent and explicit user authorization",
    );
  const target = command === "create" ? get("--on") : parsed.positionals[0];
  let reference;
  try {
    reference = target ? parseThreadReference(target) : undefined;
  } catch {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Use a complete machine-qualified Thread link",
    );
  }
  if (reference && !reference.machineId)
    throw new DelegationControlError("INVALID_ARGUMENT", "Copy a machine-qualified Thread link");
  if (get("--machine") && reference && get("--machine") !== reference.machineId)
    throw new DelegationControlError("INVALID_ARGUMENT", "--machine conflicts with --on");
  const action =
    command === "create"
      ? { operation: command, cwd: get("--cwd"), harnessId: get("--harness") ?? "codex" }
      : {
          operation: command,
          threadId: reference?.threadId,
          ...(command === "rename" ? { name: get("--name") } : {}),
        };
  const result = threadManagementInputSchema.safeParse({
    ...(reference?.machineId || get("--machine")
      ? { machineId: reference?.machineId ?? get("--machine") }
      : {}),
    ...(reference?.hostId ? { hostId: reference.hostId } : {}),
    requestId: get("--request-id") ?? randomUUID(),
    action,
  });
  if (!result.success)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Invalid Thread operation; provide the required target, --cwd/--name and a UUID request ID if specified",
    );
  return result.data;
}
