import { readNativeCodexThread, usesIndependentNativeInference } from "./renderer-native-thread.js";

type SendRequest = (method: string, params: unknown) => Promise<unknown> | unknown;
const officialProvider = (id: string): boolean => ["openai", "cc-switch-official"].includes(id);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function inspectNativeProviderContinuation(
  sendRequest: SendRequest,
  threadId: string,
): Promise<string | null> {
  const thread = await readNativeCodexThread(sendRequest, threadId);
  if (!officialProvider(thread.modelProvider) || !thread.cwd || !thread.idle) return null;
  const value = await sendRequest("config/read", { includeLayers: false, cwd: thread.cwd });
  const config = isRecord(value) ? value.config : null;
  return isRecord(config) &&
    typeof config.model_provider === "string" &&
    usesIndependentNativeInference(value)
    ? config.model_provider
    : null;
}

/** An explicit Provider change, not a quota bypass for an official session. */
export async function continueNativeWithConfiguredProvider(
  sendRequest: SendRequest,
  threadId: string,
  providerId: string,
): Promise<void> {
  if ((await inspectNativeProviderContinuation(sendRequest, threadId)) !== providerId) {
    throw new Error("Configured independent Provider is no longer available for this Thread");
  }
  const snapshot = await sendRequest("thread/resume", { threadId, excludeTurns: true });
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.thread) ||
    snapshot.thread.id !== threadId ||
    typeof snapshot.modelProvider !== "string" ||
    !officialProvider(snapshot.modelProvider) ||
    typeof snapshot.model !== "string" ||
    typeof snapshot.cwd !== "string" ||
    !isRecord(snapshot.sandbox) ||
    !["readOnly", "workspaceWrite", "dangerFullAccess"].includes(String(snapshot.sandbox.type)) ||
    snapshot.approvalPolicy === undefined
  ) {
    throw new Error("Native runtime cannot establish restorable Thread settings");
  }
  const resume: Record<string, unknown> = { threadId, excludeTurns: true };
  for (const key of [
    "model",
    "modelProvider",
    "cwd",
    "runtimeWorkspaceRoots",
    "approvalPolicy",
    "approvalsReviewer",
    "serviceTier",
  ]) {
    if (snapshot[key] !== undefined) resume[key] = snapshot[key];
  }
  const profile = snapshot.activePermissionProfile;
  if (isRecord(profile) && typeof profile.id === "string" && profile.id) {
    resume.permissions = profile.id;
  } else {
    resume.sandbox = {
      readOnly: "read-only",
      workspaceWrite: "workspace-write",
      dangerFullAccess: "danger-full-access",
    }[String(snapshot.sandbox.type)];
  }
  const settings: Record<string, unknown> = { threadId };
  if (resume.permissions) settings.permissions = resume.permissions;
  else settings.sandboxPolicy = snapshot.sandbox;
  for (const key of ["disabledPluginIds", "collaborationMode"]) {
    if (snapshot[key] !== undefined) settings[key] = snapshot[key];
  }
  if (snapshot.reasoningEffort !== undefined) {
    settings.effort = snapshot.reasoningEffort;
    if (typeof snapshot.reasoningEffort === "string") {
      resume.config = { model_reasoning_effort: snapshot.reasoningEffort };
    }
  }
  // Rejoining an already-running Thread ignores modelProvider overrides.
  // Unsubscribe only this idle Thread, never restart the shared native backend.
  const latest = await readNativeCodexThread(sendRequest, threadId);
  if (!latest.idle || latest.modelProvider !== snapshot.modelProvider) {
    throw new Error("Thread changed before the Provider continuation");
  }
  const detach = await sendRequest("thread/unsubscribe", { threadId });
  if (!isRecord(detach) || detach.status !== "unsubscribed") {
    throw new Error("Native Thread could not be unsubscribed for the Provider continuation");
  }
  try {
    if ((await inspectNativeProviderContinuation(sendRequest, threadId)) !== providerId) {
      throw new Error("Configured Provider changed before the continuation");
    }
    const changed = await sendRequest("thread/resume", { ...resume, modelProvider: providerId });
    // loaded/list can retain this idle Thread after unsubscribe. Only the
    // resume response establishes whether the native runtime adopted the change.
    if (
      !isRecord(changed) ||
      !isRecord(changed.thread) ||
      changed.thread.id !== threadId ||
      changed.modelProvider !== providerId
    ) {
      throw new Error("Native runtime did not adopt the selected independent Provider");
    }
    await sendRequest("thread/settings/update", settings);
    if ((await readNativeCodexThread(sendRequest, threadId)).modelProvider !== providerId) {
      throw new Error("Native Thread did not retain the selected Provider");
    }
  } catch (error) {
    try {
      const latest = await readNativeCodexThread(sendRequest, threadId);
      if (!latest.idle) throw new Error("Cannot restore Provider settings while a Turn is active");
      if (latest.modelProvider !== snapshot.modelProvider) {
        await sendRequest("thread/unsubscribe", { threadId });
      }
      const restored = await sendRequest("thread/resume", resume);
      if (!isRecord(restored) || restored.modelProvider !== snapshot.modelProvider) {
        throw new Error("Native runtime did not restore the original Provider");
      }
      await sendRequest("thread/settings/update", settings);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Native Provider continuation and restoration failed",
      );
    }
    throw error;
  }
}
