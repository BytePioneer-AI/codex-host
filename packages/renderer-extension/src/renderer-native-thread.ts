function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify that a Thread belongs to native Codex on the same request connection.
 * @param sendRequest Sends a Desktop app-server request.
 * @param threadId The Thread identity being checked.
 */
export async function verifyNativeCodexThread(
  sendRequest: (method: string, params: unknown) => Promise<unknown> | unknown,
  threadId: string,
): Promise<void> {
  const native = await sendRequest("thread/read", { threadId, includeTurns: false });
  const thread = isRecord(native) ? native.thread : null;
  // External projections reserve both markers, so a stock RPC failure cannot
  // silently change a Harness Thread into a native Codex Thread.
  if (
    !isRecord(thread) ||
    thread.id !== threadId ||
    typeof thread.modelProvider !== "string" ||
    !thread.modelProvider ||
    thread.modelProvider === "codexhost" ||
    typeof thread.cliVersion !== "string" ||
    !thread.cliVersion ||
    thread.cliVersion === "codexhost"
  ) {
    throw new Error("Native Thread response cannot establish Codex ownership");
  }
}
