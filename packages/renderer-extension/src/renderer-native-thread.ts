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

export function usesOfficialNativeInference(value: unknown, modelProvider?: string): boolean {
  const config = isRecord(value) ? value.config : null;
  if (!isRecord(config)) return false;
  const providerId = modelProvider ?? config.model_provider;
  if (providerId !== "openai" && providerId !== "cc-switch-official") return false;
  const providers = config.model_providers;
  const provider = isRecord(providers) ? providers[providerId] : undefined;
  if (provider === undefined || provider === null) return providerId === "openai";
  if (
    !isRecord(provider) ||
    provider.requires_openai_auth !== true ||
    (provider.experimental_bearer_token !== undefined &&
      provider.experimental_bearer_token !== null &&
      provider.experimental_bearer_token !== "") ||
    (provider.env_key !== undefined && provider.env_key !== null && provider.env_key !== "")
  ) {
    return false;
  }
  if (provider.base_url === undefined || provider.base_url === null) return providerId === "openai";
  return (
    typeof provider.base_url === "string" &&
    URL.canParse(provider.base_url) &&
    ["http:", "https:"].includes(new URL(provider.base_url).protocol)
  );
}

/**
 * Verify that a Thread belongs to native Codex on the same request connection.
 * @param sendRequest Sends a Desktop app-server request.
 * @param threadId The Thread identity being checked.
 */
function nativeThreadResponse(native: unknown, threadId: string): Record<string, unknown> {
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
  return thread;
}

export async function readNativeCodexThread(
  sendRequest: (method: string, params: unknown) => Promise<unknown> | unknown,
  threadId: string,
  options: { allowTerminalError?: boolean } = {},
): Promise<{ modelProvider: string; cwd: string | null; idle: boolean }> {
  let thread = nativeThreadResponse(
    await sendRequest("thread/read", { threadId, includeTurns: false }),
    threadId,
  );
  if (
    options.allowTerminalError &&
    isRecord(thread.status) &&
    thread.status.type === "systemError"
  ) {
    thread = nativeThreadResponse(
      await sendRequest("thread/read", { threadId, includeTurns: true }),
      threadId,
    );
  }
  const terminalError =
    options.allowTerminalError === true &&
    isRecord(thread.status) &&
    thread.status.type === "systemError" &&
    Array.isArray(thread.turns) &&
    thread.turns.length > 0 &&
    thread.turns.every(
      (turn) =>
        isRecord(turn) && ["completed", "failed", "interrupted"].includes(String(turn.status)),
    );
  return {
    modelProvider: String(thread.modelProvider),
    cwd: typeof thread.cwd === "string" && thread.cwd ? thread.cwd : null,
    idle:
      terminalError ||
      (isRecord(thread.status) && ["idle", "notLoaded"].includes(String(thread.status.type))),
  };
}

export async function verifyNativeCodexThread(
  sendRequest: (method: string, params: unknown) => Promise<unknown> | unknown,
  threadId: string,
): Promise<string> {
  return (await readNativeCodexThread(sendRequest, threadId)).modelProvider;
}
