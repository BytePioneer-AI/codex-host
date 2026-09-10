import type { HostSubagentDelegationItem, HostSubagentStatus } from "@codexhost/harness-adapter";
import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { record, text } from "./common.js";

export const validCodeBuddyChildId = (id: string) => /^agent-[a-zA-Z0-9_-]{1,100}$/u.test(id);

export function codeBuddyChildId(value: unknown): string | undefined {
  const row = record(value);
  const structured = text(record(record(record(row.providerData).toolResult).subAgent).sessionId);
  const body = text(record(row.rawOutput ?? row.output).text);
  const id = structured || /\[Agent ID: (agent-[a-zA-Z0-9_-]+)\]\s*$/u.exec(body)?.[1];
  return id && validCodeBuddyChildId(id) ? id : undefined;
}

export function codeBuddyDelegation(
  callId: string,
  input: unknown,
  status: HostSubagentStatus,
  childId?: string,
): HostSubagentDelegationItem {
  const args = record(input);
  const resumed = text(args.resume);
  const nativeId = childId ?? (validCodeBuddyChildId(resumed) ? resumed : undefined);
  return {
    type: "subagentDelegation",
    itemId: hostItemIdSchema.parse(`tool-${callId}`),
    operation: resumed ? "send" : "spawn",
    ...(text(args.prompt) ? { prompt: text(args.prompt) } : {}),
    subagents: [
      {
        subagentId: nativeId ?? callId,
        ...(nativeId ? { nativeSubagentId: nativeId } : {}),
        description: text(args.description) || "CodeBuddy Subagent",
        ...(text(args.subagent_type) ? { role: text(args.subagent_type) } : {}),
        ...(text(args.model) ? { model: text(args.model) } : {}),
        background: args.run_in_background === true,
        status,
      },
    ],
  };
}
