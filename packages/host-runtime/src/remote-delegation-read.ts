import { requestDesktopRemoteConnections } from "@codexhost/desktop-control";
import {
  delegationReadParamsSchema,
  delegationThreadSnapshotSchema,
} from "@codexhost/shared-contracts";
import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type ThreadReadInput,
} from "./delegation-types.js";

/** Uses the existing authenticated Desktop connection, never an arbitrary endpoint or shell. */
export async function readRemoteDelegationThread(
  environment: NodeJS.ProcessEnv,
  input: ThreadReadInput,
): Promise<DelegationThreadSnapshot> {
  const { hostId, ...read } = input;
  const reply = await requestDesktopRemoteConnections(environment, {
    action: "read-thread",
    hostId,
    input: delegationReadParamsSchema.parse(read),
  });
  if ("error" in reply)
    throw new DelegationControlError(
      reply.error.code === -32094 ? "RESPONSE_TOO_LARGE" : "RUNTIME_UNREACHABLE",
      reply.error.message,
    );
  const parsed = delegationThreadSnapshotSchema.safeParse(reply.result);
  if (!parsed.success || parsed.data.threadId !== input.threadId)
    throw new DelegationControlError(
      "INTERNAL_ERROR",
      "Remote Host returned an invalid Thread snapshot",
    );
  // JSON transport omits undefined properties; the schema validates every snapshot field.
  return { ...parsed.data, hostId } as DelegationThreadSnapshot;
}
