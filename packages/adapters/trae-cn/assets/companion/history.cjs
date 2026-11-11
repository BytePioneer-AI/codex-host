function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Fork is a native history write, never a Prompt or a source-history mutation. */
async function forkNativeSession(service, input) {
  if (
    typeof input.sessionId !== "string" ||
    !input.sessionId ||
    (input.messageId !== undefined && (typeof input.messageId !== "string" || !input.messageId))
  )
    throw failure("invalidRequest", "Invalid native fork identity");
  const settings = await service.historySettings();
  if (!(input.messageId ? settings.forkFromMessage : settings.forkFromSession))
    throw failure("unsupported", "TRAE CN Desktop has disabled this fork operation");
  const source = await service.call("snapshot", { sessionId: input.sessionId });
  if (source.items.some((item) => item.fileDiffs !== undefined))
    throw failure(
      "unsupported",
      "TRAE CN file-edit snapshot forks are unavailable in the verified Desktop version",
    );
  if (![4, 5, 6, 7].includes(source.status))
    throw failure("sessionBusy", "The native source Session is not idle");
  if (
    input.messageId &&
    !source.items.some(
      (item) =>
        item.message_id === input.messageId &&
        item.role === "assistant" &&
        ["completed", "failed", "canceled", "cancelled"].includes(item.status),
    )
  )
    throw failure(
      "checkpointNotFound",
      "The native fork boundary is not a completed assistant message",
    );
  const result = await service.native.call(
    "lite",
    "fork_session",
    {
      session_id: input.sessionId,
      project_id: source.projectId,
      ...(input.messageId ? { message_id: input.messageId } : {}),
    },
    { project_id: source.projectId, chat_session_id: input.sessionId },
  );
  const sessionId = result?.new_session_id;
  if (typeof sessionId !== "string" || !sessionId || sessionId === input.sessionId)
    throw failure(
      "protocolError",
      "Native fork admission is uncertain; inspect existing Sessions before retrying",
    );
  try {
    const derived = await service.readSession(sessionId);
    if (derived.projectId !== source.projectId)
      throw failure("protocolError", "Native fork changed workspace Project");
    const unchanged = await service.call("snapshot", { sessionId: input.sessionId });
    if (JSON.stringify(unchanged) !== JSON.stringify(source))
      throw failure("protocolError", "Native fork changed its source history");
    return { sessionId, projectId: source.projectId };
  } catch (error) {
    // The native child contains copied user history; never delete a Session
    // whose ownership or activity was not verified. Preserve the exact handle.
    throw failure(
      error.code ?? "nativeFailure",
      `Derived Session ${sessionId} was preserved: ${error.message}`,
    );
  }
}

module.exports = { forkNativeSession };
