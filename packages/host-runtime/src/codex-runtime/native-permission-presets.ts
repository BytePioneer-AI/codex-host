import type { JsonObject } from "@codexhost/protocol-core";

export const CODEX_WORKSPACE_PROFILE = ":workspace";
export const CODEX_APPROVE_FOR_ME_MODE = ":codexhost-approve-for-me";

export const codexApproveForMeSettings = {
  permissions: CODEX_WORKSPACE_PROFILE,
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
};

function record(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canSelectCodexApproveForMe(result: unknown): boolean {
  if (!record(result)) return false;
  const requirements = result.requirements;
  if (requirements === null) return true;
  if (!record(requirements)) return false;
  const { allowedApprovalPolicies, allowedApprovalsReviewers } = requirements;
  return (
    (allowedApprovalPolicies == null ||
      (Array.isArray(allowedApprovalPolicies) && allowedApprovalPolicies.includes("on-request"))) &&
    (allowedApprovalsReviewers == null ||
      (Array.isArray(allowedApprovalsReviewers) &&
        allowedApprovalsReviewers.some(
          (reviewer) => reviewer === "auto_review" || reviewer === "guardian_subagent",
        )))
  );
}

export function nativePermissionSettingsMatch(settings: JsonObject, applied: JsonObject): boolean {
  return (
    (settings.permissions === undefined ||
      (record(applied.activePermissionProfile) &&
        applied.activePermissionProfile.id === settings.permissions)) &&
    (settings.approvalPolicy === undefined || applied.approvalPolicy === settings.approvalPolicy) &&
    (settings.approvalsReviewer === undefined ||
      applied.approvalsReviewer === settings.approvalsReviewer)
  );
}

export function nativePermissionModeId(settings: JsonObject): string | undefined {
  const profile = settings.activePermissionProfile;
  const id = record(profile) && typeof profile.id === "string" ? profile.id : undefined;
  const sandbox = settings.sandboxPolicy ?? settings.sandbox;
  const workspace =
    id === CODEX_WORKSPACE_PROFILE ||
    (id === undefined && record(sandbox) && sandbox.type === "workspaceWrite");
  if (
    workspace &&
    settings.approvalPolicy === codexApproveForMeSettings.approvalPolicy &&
    (settings.approvalsReviewer === codexApproveForMeSettings.approvalsReviewer ||
      settings.approvalsReviewer === "guardian_subagent")
  )
    return CODEX_APPROVE_FOR_ME_MODE;
  return id;
}
