/** Pi 1.4's Codex provider can persist AbortSignal cancellation as an error terminal. */
export function piAssistantWasAborted(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" ||
      (message.stopReason === "error" && message.errorMessage === "This operation was aborted"))
  );
}

export type PiAssistantPhase = "commentary" | "final_answer";

/** Pi's Responses text signature preserves the provider's public message phase. */
export function piAssistantPhase(value: unknown): PiAssistantPhase | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return undefined;
  const lastText = Array.isArray(message.content)
    ? message.content.findLast(
        (part: unknown): part is Record<string, unknown> =>
          typeof part === "object" &&
          part !== null &&
          !Array.isArray(part) &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string" &&
          part.text.trim().length > 0,
      )
    : undefined;
  if (!lastText && !(typeof message.content === "string" && message.content.trim()))
    return undefined;
  if (typeof lastText?.textSignature === "string") {
    try {
      const signature: unknown = JSON.parse(lastText.textSignature);
      if (
        typeof signature === "object" &&
        signature !== null &&
        !Array.isArray(signature) &&
        "v" in signature &&
        signature.v === 1 &&
        "id" in signature &&
        typeof signature.id === "string" &&
        "phase" in signature &&
        (signature.phase === "commentary" || signature.phase === "final_answer")
      )
        return signature.phase;
    } catch {
      // Legacy signatures are opaque IDs, not JSON phase metadata.
    }
  }
  if (message.stopReason === "toolUse") return "commentary";
  if (message.stopReason === "stop") return "final_answer";
  return undefined;
}
