function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClaudeQueuedCommand {
  /** Persisted attachment identity; distinct from the SDK input UUID. */
  uuid: string;
  sourceUuid: string;
  prompt: string;
}

/** Only a delivered root human prompt is historical steering, never an arbitrary attachment. */
export function readClaudeQueuedCommand(
  value: Record<string, unknown>,
  sessionId: string,
): ClaudeQueuedCommand | null {
  const attachment = value.attachment;
  if (
    value.type !== "attachment" ||
    !isRecord(attachment) ||
    attachment.type !== "queued_command" ||
    attachment.commandMode !== "prompt" ||
    !isRecord(attachment.origin) ||
    attachment.origin.kind !== "human" ||
    attachment.humanTurn === false ||
    attachment.isMeta === true ||
    attachment.isSynthetic === true ||
    value.isMeta === true ||
    value.isSynthetic === true ||
    value.isSidechain === true ||
    (isRecord(value.origin) && value.origin.kind !== "human") ||
    (typeof value.parent_tool_use_id === "string" && value.parent_tool_use_id.length > 0) ||
    (value.sessionId !== undefined && value.sessionId !== sessionId) ||
    value.session_id !== sessionId
  ) {
    return null;
  }
  const prompt = promptText(attachment.prompt);
  if (
    typeof value.uuid !== "string" ||
    value.uuid.length === 0 ||
    typeof attachment.source_uuid !== "string" ||
    attachment.source_uuid.length === 0 ||
    prompt.length === 0
  ) {
    throw new Error("Claude queued human input has an invalid identity or text prompt");
  }
  return { uuid: value.uuid, sourceUuid: attachment.source_uuid, prompt };
}

/** A prompt with images is persisted as content blocks; its text blocks are the prompt. */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}
