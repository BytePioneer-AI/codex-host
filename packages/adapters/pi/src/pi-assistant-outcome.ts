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
