import type { HostApprovalAction, HostApprovalEffect } from "@codexhost/harness-adapter";

export interface MuseRequirementRef {
  approvalId: string;
  sourceIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMuseRequirementRef(value: unknown): MuseRequirementRef | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.approvalId !== "string" || value.approvalId.trim().length === 0) {
    return undefined;
  }
  if (typeof value.sourceIndex !== "number" || !Number.isInteger(value.sourceIndex)) {
    return undefined;
  }
  return { approvalId: value.approvalId, sourceIndex: value.sourceIndex };
}

export function museApprovalEffect(
  choice: Record<string, unknown>,
): HostApprovalEffect | undefined {
  const decision = typeof choice.decision === "string" ? choice.decision : "";
  const scope = typeof choice.scope === "string" ? choice.scope : "";
  if (
    decision === "denied" ||
    decision === "deniedPolicyAmendment" ||
    decision === "abort" ||
    decision === "timedOut"
  ) {
    return "deny";
  }
  if (decision === "approvedForSession" || (decision === "approved" && scope === "session")) {
    return "allowForSession";
  }
  if (
    decision === "approvedPolicyAmendment" ||
    (decision === "approved" && scope === "localPersistent")
  ) {
    return "allowAlways";
  }
  if (decision === "approved") return "allowOnce";
  return undefined;
}

export function mapMuseApprovalActions(choices: unknown): HostApprovalAction[] {
  if (!Array.isArray(choices)) return [];
  const byEffect = new Map<HostApprovalEffect, HostApprovalAction>();
  for (const raw of choices) {
    if (!isRecord(raw)) continue;
    const choiceId = typeof raw.choiceId === "string" ? raw.choiceId.trim() : "";
    if (!choiceId) continue;
    const effect = museApprovalEffect(raw);
    if (!effect || byEffect.has(effect)) continue;
    const label =
      typeof raw.label === "string" && raw.label.trim().length > 0 ? raw.label.trim() : choiceId;
    byEffect.set(effect, { id: choiceId, label, effect });
  }
  const order: HostApprovalEffect[] = ["allowOnce", "allowForSession", "allowAlways", "deny"];
  return order.flatMap((effect) => {
    const action = byEffect.get(effect);
    return action ? [action] : [];
  });
}

export function museApprovalProjectionReady(actions: HostApprovalAction[]): boolean {
  const allows = actions.some(
    (action) =>
      action.effect === "allowOnce" ||
      action.effect === "allowForSession" ||
      action.effect === "allowAlways",
  );
  return allows && actions.some((action) => action.effect === "deny");
}

export function museApprovalTitle(params: Record<string, unknown>): string {
  if (typeof params.toolName === "string" && params.toolName.trim()) return params.toolName.trim();
  if (typeof params.title === "string" && params.title.trim()) return params.title.trim();
  return "Muse tool approval";
}

export function museApprovalDescription(params: Record<string, unknown>): string | undefined {
  if (typeof params.message === "string" && params.message.trim()) return params.message.trim();
  if (typeof params.rawArgs === "string" && params.rawArgs.trim()) return params.rawArgs.trim();
  return undefined;
}
