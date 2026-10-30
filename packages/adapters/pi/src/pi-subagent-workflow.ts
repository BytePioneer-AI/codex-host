import type { HostSubagentDelegationItem, HostSubagentStatus } from "@codexhost/harness-adapter";
import type { HostItemId } from "@codexhost/shared-contracts";

const PREFIX = "pi-subagents-workflow-v1:";
const STATES: Record<string, HostSubagentStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  paused: "interrupted",
  stopped: "interrupted",
  rejected: "failed",
  detached: "running",
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, limit = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

export interface PiWorkflowChild {
  childId: string;
  state: HostSubagentStatus;
  background: boolean;
  agent?: string;
  sessionName?: string;
  model?: string;
  thinking?: string;
}
export interface PiWorkflowSummary {
  workflowRunId: string;
  parentToolCallId: string;
  children: PiWorkflowChild[];
}

/** Foreground workflows have no asyncId/widget. Their public v1 inventory is the native identity source. */
export function piWorkflowSummary(result: unknown): PiWorkflowSummary | null {
  if (
    !record(result) ||
    !record(result.details) ||
    result.details.mode !== "workflow" ||
    result.details.asyncId !== undefined
  )
    return null;
  const details = result.details;
  const summary = details.workflowChildren;
  if (
    !record(summary) ||
    summary.version !== 1 ||
    !text(summary.workflowRunId) ||
    summary.workflowRunId !== details.runId ||
    !text(summary.parentToolCallId) ||
    typeof summary.inventoryComplete !== "boolean" ||
    !Array.isArray(summary.children) ||
    summary.children.length > 256
  )
    return null;
  const children: PiWorkflowChild[] = [];
  const seen = new Set<string>();
  for (const child of summary.children) {
    if (
      !record(child) ||
      !text(child.childId) ||
      seen.has(child.childId) ||
      typeof child.state !== "string" ||
      !Object.hasOwn(STATES, child.state)
    )
      return null;
    for (const key of ["agent", "sessionName", "model", "thinking"]) {
      if (child[key] !== undefined && !text(child[key], 2048)) return null;
    }
    const mappedState = STATES[child.state];
    if (!mappedState) return null;
    seen.add(child.childId);
    children.push({
      childId: child.childId,
      state: mappedState,
      background: child.state === "detached",
      ...(typeof child.agent === "string" ? { agent: child.agent } : {}),
      ...(typeof child.sessionName === "string" ? { sessionName: child.sessionName } : {}),
      ...(typeof child.model === "string" ? { model: child.model } : {}),
      ...(typeof child.thinking === "string" ? { thinking: child.thinking } : {}),
    });
  }
  return {
    workflowRunId: summary.workflowRunId,
    parentToolCallId: summary.parentToolCallId,
    children,
  };
}

export interface PiWorkflowAddress {
  workflowRunId: string;
  childId: string;
}
export function piWorkflowSubagentId(address: PiWorkflowAddress): string {
  return (
    PREFIX +
    Buffer.from(JSON.stringify([address.workflowRunId, address.childId])).toString("base64url")
  );
}
export function parsePiWorkflowSubagentId(id: string): PiWorkflowAddress | null {
  if (!id.startsWith(PREFIX)) return null;
  if (id.length > 3000) throw new Error("Invalid Pi workflow child identity");
  const value: unknown = JSON.parse(
    Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8"),
  );
  if (!Array.isArray(value) || value.length !== 2 || !text(value[0]) || !text(value[1]))
    throw new Error("Invalid Pi workflow child identity");
  const address = { workflowRunId: value[0], childId: value[1] };
  if (piWorkflowSubagentId(address) !== id)
    throw new Error("Non-canonical Pi workflow child identity");
  return address;
}

export function projectPiWorkflow(
  summary: PiWorkflowSummary,
  itemId: HostItemId,
): HostSubagentDelegationItem | null {
  if (!summary.children.length) return null;
  return {
    type: "subagentDelegation",
    itemId,
    operation: "spawn",
    subagents: summary.children.map((child) => {
      const id = piWorkflowSubagentId({
        workflowRunId: summary.workflowRunId,
        childId: child.childId,
      });
      return {
        subagentId: id,
        nativeSubagentId: id,
        description: child.sessionName ?? child.agent ?? child.childId,
        status: child.state,
        background: child.background,
        ...(child.agent ? { role: child.agent } : {}),
        ...(child.model ? { model: child.model } : {}),
        ...(child.thinking ? { reasoningEffort: child.thinking } : {}),
      };
    }),
  };
}
