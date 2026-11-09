/** Minimal native CLI 2.1.319 record shape; identities, prompts and paths are synthetic. */
export function queuedCommand(
  uuid: string,
  sourceUuid: string,
  prompt: string,
  sessionId = "session-1",
) {
  return {
    type: "attachment",
    uuid,
    parentUuid: "tool-result",
    sessionId,
    session_id: sessionId,
    isSidechain: false,
    timestamp: "2026-01-01T00:00:01.000Z",
    attachment: {
      type: "queued_command",
      prompt,
      source_uuid: sourceUuid,
      delivery_id: `delivery-${sourceUuid}`,
      commandMode: "prompt",
      origin: { kind: "human" },
      humanTurn: true,
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    renderedRole: "system",
    rendered: [{ content: "Native reminder wrapping the human prompt" }],
  };
}

export function historyMessage(
  type: "user" | "assistant",
  uuid: string,
  content: unknown,
  sessionId = "session-1",
) {
  return {
    type,
    uuid,
    sessionId,
    session_id: sessionId,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: type, content },
  };
}
