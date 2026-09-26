// Narrow, checked changes to the pinned Apache-2.0 ZCode source at bundle time.
// Preserve native authentication ownership and strict event identity validation.
// Verification callbacks supply only per-request headers, never account credentials.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Pinned ZCode source patch no longer matches");
  return source.replace(before, after);
}

export function patchNativeSource(file, source) {
  if (file.endsWith("/packages/shared/src/zcode-protocol/index.ts")) {
    // The pinned CLI always emits this field; the Services strict schema otherwise
    // discards the entire turn.started event, including its durable message identity.
    return replaceOnce(
      source,
      "export const zcodeTurnStartedEventPayloadSchema = z\n  .object({\n    turnNumber:",
      "export const zcodeTurnStartedEventPayloadSchema = z\n  .object({\n    executionStartedAt: z.number().finite().nonnegative().optional(),\n    turnNumber:",
    );
  }
  if (file.endsWith("/packages/shared/src/clientConfig.ts")) {
    source = replaceOnce(
      source,
      "  pluginStoreOrder: PluginStoreOrder | null;",
      "  pluginStoreOrder: PluginStoreOrder | null;\n  captcha?: { enabled?: boolean; region?: string; prefix?: string; sceneId?: string } | null;",
    );
    source = replaceOnce(
      source,
      "configs: z.object({ pluginStoreOrder: z.unknown().optional() }).nullish(),",
      "configs: z.object({ pluginStoreOrder: z.unknown().optional(), captcha: z.object({ enabled: z.boolean().optional(), region: z.string().optional(), prefix: z.string().optional(), sceneId: z.string().optional() }).nullish() }).nullish(),",
    );
    return replaceOnce(
      source,
      "return { pluginStoreOrder: parsePluginStoreOrder(parsed.data.data?.configs?.pluginStoreOrder) };",
      "return { pluginStoreOrder: parsePluginStoreOrder(parsed.data.data?.configs?.pluginStoreOrder), captcha: parsed.data.data?.configs?.captcha ?? null };",
    );
  }
  if (file.endsWith("/packages/services/src/node.ts")) {
    source = replaceOnce(
      source,
      "export function createLocalServices(options: {",
      "export function createLocalServices(options: {\n  resolveRuntimeProviderHeaders?: (request: import('@zcode/shared').ZCodeProviderRuntimeHeadersRequestParams, signal: AbortSignal) => Promise<Record<string, string>>;",
    );
    return replaceOnce(
      source,
      "  const zcodeAgentService = createZCodeAgentService({",
      "  const zcodeAgentService = createZCodeAgentService({\n    resolveRuntimeProviderHeaders: options.resolveRuntimeProviderHeaders,",
    );
  }
  if (file.endsWith("/packages/services/src/zcode-agent/zcodeAgentService.ts")) {
    source = replaceOnce(
      source,
      "interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {",
      "interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {\n  verificationAbort: AbortController;",
    );
    source = replaceOnce(
      source,
      "  accountRequestAuthService?: IAccountRequestAuthService;",
      "  accountRequestAuthService?: IAccountRequestAuthService;\n  resolveRuntimeProviderHeaders?: (request: ZCodeProviderRuntimeHeadersRequestParams, signal: AbortSignal) => Promise<Record<string, string>>;",
    );
    source = replaceOnce(
      source,
      "    pendingProviderRuntimeHeaders.delete(key);\n    const { requestId, sessionId, workspace } = pending.request;",
      "    pendingProviderRuntimeHeaders.delete(key);\n    pending.verificationAbort.abort();\n    const { requestId, sessionId, workspace } = pending.request;",
    );
    source = replaceOnce(
      source,
      "      const requestAuth = await resolveAccountRequestAuth(params.pending.request);",
      "      const requestAuth = await resolveAccountRequestAuth(params.pending.request);\n      const verificationHeaders = await options?.resolveRuntimeProviderHeaders?.(params.pending.request, params.pending.verificationAbort.signal);\n      if (requestAuth && verificationHeaders) requestAuth.headers = { ...requestAuth.headers, ...verificationHeaders };",
    );
    source = replaceOnce(
      source,
      "            request: parsed.data,\n          };\n          pendingProviderRuntimeHeaders.set",
      "            request: parsed.data,\n            verificationAbort: new AbortController(),\n          };\n          pendingProviderRuntimeHeaders.set",
    );
    return replaceOnce(
      source,
      "    pendingProviderRuntimeHeaders.clear();",
      "    for (const pending of pendingProviderRuntimeHeaders.values()) pending.verificationAbort.abort();\n    pendingProviderRuntimeHeaders.clear();",
    );
  }
  return undefined;
}
