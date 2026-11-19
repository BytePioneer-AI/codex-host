/** Local management requests for Web interface extensions. */
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import { webUiExtensionsStateSchema, type WebUiExtensionsState } from "@codexhost/shared-contracts";
import { ApiError } from "./api.ts";

async function request(
  action: "list" | "install" | "setEnabled" | "remove",
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WebUiExtensionsState> {
  const method = `codexhost/uiExtensions/${action}`;
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    }),
    signal,
  });
  const envelope = (await response.json()) as {
    result?:
      | { ok: true; value: unknown }
      | { ok: false; error: { message: string; code: string; details?: unknown } };
  };
  if (envelope.result?.ok === false) {
    const { message, code, details } = envelope.result.error;
    throw new ApiError(message, code, details);
  }
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return webUiExtensionsStateSchema.parse(envelope.result?.value);
}

export const uiExtensionsApi = {
  list: (signal?: AbortSignal) => request("list", {}, signal),
  install: (spec: string, registry?: string) =>
    request("install", { spec, ...(registry === undefined ? {} : { registry }) }),
  setEnabled: (id: string, enabled: boolean) => request("setEnabled", { id, enabled }),
  remove: (id: string) => request("remove", { id }),
};
