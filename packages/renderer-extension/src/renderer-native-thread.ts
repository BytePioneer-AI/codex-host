function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usesIndependentNativeInference(value: unknown, modelProvider?: string): boolean {
  const config = isRecord(value) ? value.config : null;
  if (!isRecord(config)) return false;
  const providerId = modelProvider ?? config.model_provider;
  if (typeof providerId !== "string") return false;
  if (["openai", "cc-switch-official", "codexhost"].includes(providerId)) return false;
  const providers = config.model_providers;
  const provider = isRecord(providers) ? providers[providerId] : null;
  if (!isRecord(provider) || typeof provider.base_url !== "string") return false;
  if (!URL.canParse(provider.base_url)) return false;
  const endpoint = new URL(provider.base_url);
  if (!["http:", "https:"].includes(endpoint.protocol)) return false;
  if (
    ["openai.com", "chatgpt.com"].some(
      (domain) => endpoint.hostname === domain || endpoint.hostname.endsWith(`.${domain}`),
    )
  ) {
    return false;
  }
  return (
    provider.requires_openai_auth === false ||
    (typeof provider.experimental_bearer_token === "string" &&
      provider.experimental_bearer_token.trim().length > 0) ||
    (typeof provider.env_key === "string" && provider.env_key.trim().length > 0)
  );
}

/**
 * Verify that a Thread belongs to native Codex on the same request connection.
 * @param sendRequest Sends a Desktop app-server request.
 * @param threadId The Thread identity being checked.
 */
export async function verifyNativeCodexThread(
  sendRequest: (method: string, params: unknown) => Promise<unknown> | unknown,
  threadId: string,
): Promise<string> {
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
  return thread.modelProvider;
}
