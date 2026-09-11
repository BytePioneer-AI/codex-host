import { isDeepStrictEqual } from "node:util";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ActivePermissionProfile {
  id: string;
  extends: string | null;
}

/** Effective settings returned by 0.153.4 when rejoining an already loaded Thread. */
export interface OfficialThreadSettingsSnapshot {
  threadId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  approvalPolicy: JsonValue;
  approvalsReviewer: string;
  sandbox: JsonObject;
  activePermissionProfile: ActivePermissionProfile | null;
  effort: string | null;
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function parseActivePermissionProfile(value: unknown): ActivePermissionProfile | null {
  if (value === null) return null;
  if (!object(value) || typeof value.id !== "string" || !nullableString(value.extends))
    throw new Error("Official Thread settings capture failed");
  return { id: value.id, extends: value.extends };
}

export function parseOfficialThreadSettings(response: JsonObject): OfficialThreadSettingsSnapshot {
  const thread = response.thread;
  const roots = response.runtimeWorkspaceRoots;
  const profile = parseActivePermissionProfile(response.activePermissionProfile);
  if (
    !object(thread) ||
    typeof thread.id !== "string" ||
    typeof response.model !== "string" ||
    typeof response.modelProvider !== "string" ||
    !nullableString(response.serviceTier) ||
    typeof response.cwd !== "string" ||
    !Array.isArray(roots) ||
    !roots.every((root) => typeof root === "string") ||
    !(typeof response.approvalPolicy === "string" || object(response.approvalPolicy)) ||
    typeof response.approvalsReviewer !== "string" ||
    !object(response.sandbox) ||
    typeof response.sandbox.type !== "string" ||
    !nullableString(response.reasoningEffort)
  )
    throw new Error("Official Thread settings capture failed");

  return {
    threadId: thread.id,
    model: response.model,
    modelProvider: response.modelProvider,
    serviceTier: response.serviceTier,
    cwd: response.cwd,
    runtimeWorkspaceRoots: [...roots],
    approvalPolicy: structuredClone(response.approvalPolicy),
    approvalsReviewer: response.approvalsReviewer,
    sandbox: structuredClone(response.sandbox),
    activePermissionProfile: profile,
    effort: response.reasoningEffort,
  };
}

const authoritativeResumeFields = new Set([
  "threadId",
  "model",
  "modelProvider",
  "serviceTier",
  "cwd",
  "runtimeWorkspaceRoots",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "permissions",
  // A Turn can update personality, but 0.153.4's resume response cannot prove it.
  // Omission preserves the native persisted value instead of replaying a stale override.
  "personality",
  "excludeTurns",
]);

export function buildOfficialThreadResumeParams(
  snapshot: OfficialThreadSettingsSnapshot,
  original: JsonObject,
): JsonObject {
  const retained = Object.fromEntries(
    Object.entries(original).filter(([key]) => !authoritativeResumeFields.has(key)),
  );
  return {
    ...retained,
    threadId: snapshot.threadId,
    model: snapshot.model,
    modelProvider: snapshot.modelProvider,
    serviceTier: snapshot.serviceTier,
    cwd: snapshot.cwd,
    runtimeWorkspaceRoots: [...snapshot.runtimeWorkspaceRoots],
    approvalPolicy: structuredClone(snapshot.approvalPolicy),
    approvalsReviewer: snapshot.approvalsReviewer,
    ...(snapshot.activePermissionProfile
      ? { permissions: snapshot.activePermissionProfile.id }
      : // The exact policy is applied by thread/settings/update before admission reopens.
        { sandbox: "read-only" }),
    excludeTurns: true,
  };
}

export function buildOfficialThreadSettingsUpdate(
  snapshot: OfficialThreadSettingsSnapshot,
): JsonObject {
  return {
    threadId: snapshot.threadId,
    effort: snapshot.effort,
    ...(snapshot.activePermissionProfile
      ? {}
      : { sandboxPolicy: structuredClone(snapshot.sandbox) }),
  };
}

export function assertOfficialThreadSettingsRestored(
  response: JsonObject,
  expected: OfficialThreadSettingsSnapshot,
): void {
  const actual = parseOfficialThreadSettings(response);
  if (!isDeepStrictEqual(actual, expected))
    throw new Error("Official Thread settings restoration failed");
}
