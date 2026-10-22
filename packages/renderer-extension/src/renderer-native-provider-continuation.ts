import {
  readNativeCodexThread,
  usesIndependentNativeInference,
  usesOfficialNativeInference,
} from "./renderer-native-thread.js";

type SendRequest = (method: string, params: unknown) => Promise<unknown> | unknown;
const officialProvider = (id: string): boolean => ["openai", "cc-switch-official"].includes(id);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readContinuableThread = (sendRequest: SendRequest, threadId: string) =>
  readNativeCodexThread(sendRequest, threadId, { allowTerminalError: true });

async function waitForNativeThreadUnload(
  sendRequest: SendRequest,
  threadId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let loaded = false;
    do {
      const page = await sendRequest("thread/loaded/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !isRecord(page) ||
        !Array.isArray(page.data) ||
        page.data.some((id) => typeof id !== "string") ||
        (page.nextCursor !== undefined &&
          page.nextCursor !== null &&
          typeof page.nextCursor !== "string")
      )
        throw new Error("Native runtime cannot establish whether this Thread was released");
      if (page.data.includes(threadId)) {
        loaded = true;
        break;
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      if (cursor && cursors.has(cursor))
        throw new Error("Native loaded Thread pagination repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!loaded) return;
    if (Date.now() >= deadline)
      throw new Error("Native Thread was not released; another connection may still own it");
    // Unsubscribe acknowledges removal of this subscriber, not client shutdown.
    // Native Codex delays unloading idle Threads before new settings can apply.
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

async function inspectContinuation(
  sendRequest: SendRequest,
  threadId: string,
): Promise<{ currentProvider: string; providerId: string; model: string | null } | null> {
  const thread = await readContinuableThread(sendRequest, threadId);
  if (!thread.cwd || !thread.idle) return null;
  const value = await sendRequest("config/read", { includeLayers: false, cwd: thread.cwd });
  const config = isRecord(value) ? value.config : null;
  if (
    !isRecord(config) ||
    typeof config.model_provider !== "string" ||
    config.model_provider === thread.modelProvider ||
    (!officialProvider(thread.modelProvider) &&
      !usesIndependentNativeInference(value, thread.modelProvider)) ||
    (!usesIndependentNativeInference(value) && !usesOfficialNativeInference(value))
  ) {
    return null;
  }
  if (
    config.model !== undefined &&
    config.model !== null &&
    (typeof config.model !== "string" || !config.model.trim())
  ) {
    return null;
  }
  return {
    currentProvider: thread.modelProvider,
    providerId: config.model_provider,
    model: typeof config.model === "string" ? config.model : null,
  };
}

export async function inspectNativeProviderContinuation(
  sendRequest: SendRequest,
  threadId: string,
): Promise<string | null> {
  return (await inspectContinuation(sendRequest, threadId))?.providerId ?? null;
}

/** An explicit configuration change, never a quota bypass for an official session. */
export async function continueNativeWithConfiguredProvider(
  sendRequest: SendRequest,
  threadId: string,
  providerId: string,
): Promise<void> {
  const candidate = await inspectContinuation(sendRequest, threadId);
  if (!candidate || candidate.providerId !== providerId) {
    throw new Error("Configured Provider is no longer available for this Thread");
  }
  const snapshot = await sendRequest("thread/resume", { threadId, excludeTurns: true });
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.thread) ||
    snapshot.thread.id !== threadId ||
    typeof snapshot.modelProvider !== "string" ||
    snapshot.modelProvider !== candidate.currentProvider ||
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
  const selectedModel = candidate.model ?? snapshot.model;
  const changedSettings = { ...settings };
  const collaboration = snapshot.collaborationMode;
  if (
    selectedModel !== snapshot.model &&
    isRecord(collaboration) &&
    isRecord(collaboration.settings) &&
    typeof collaboration.settings.model === "string"
  ) {
    changedSettings.collaborationMode = {
      ...collaboration,
      settings: { ...collaboration.settings, model: selectedModel },
    };
  }
  // Rejoining an already-running Thread ignores modelProvider overrides.
  // Unsubscribe only this idle Thread, never restart the shared native backend.
  const latest = await readContinuableThread(sendRequest, threadId);
  if (!latest.idle || latest.modelProvider !== snapshot.modelProvider) {
    throw new Error("Thread changed before the Provider continuation");
  }
  const detach = await sendRequest("thread/unsubscribe", { threadId });
  if (!isRecord(detach) || detach.status !== "unsubscribed") {
    throw new Error("Native Thread could not be unsubscribed for the Provider continuation");
  }
  try {
    await waitForNativeThreadUnload(sendRequest, threadId);
    const current = await inspectContinuation(sendRequest, threadId);
    if (
      !current ||
      current.providerId !== candidate.providerId ||
      current.currentProvider !== candidate.currentProvider ||
      current.model !== candidate.model
    ) {
      throw new Error("Configured Provider or Model changed before the continuation");
    }
    const changed = await sendRequest("thread/resume", {
      ...resume,
      modelProvider: providerId,
      model: selectedModel,
    });
    // Unloading permits a new client; resume still must confirm actual settings.
    if (
      !isRecord(changed) ||
      !isRecord(changed.thread) ||
      changed.thread.id !== threadId ||
      changed.modelProvider !== providerId ||
      changed.model !== selectedModel
    ) {
      throw new Error("Native runtime did not adopt the configured Provider and Model");
    }
    await sendRequest("thread/settings/update", changedSettings);
    if ((await readContinuableThread(sendRequest, threadId)).modelProvider !== providerId) {
      throw new Error("Native Thread did not retain the selected Provider");
    }
  } catch (error) {
    try {
      const latest = await readContinuableThread(sendRequest, threadId);
      if (!latest.idle) throw new Error("Cannot restore Provider settings while a Turn is active");
      if (latest.modelProvider !== snapshot.modelProvider) {
        await sendRequest("thread/unsubscribe", { threadId });
        await waitForNativeThreadUnload(sendRequest, threadId);
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
