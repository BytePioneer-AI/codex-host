import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gateway credentials belong to the selected provider, never Desktop OAuth. */
export async function readRealtimeGateway(environment: NodeJS.ProcessEnv) {
  let config: Record<string, unknown>;
  try {
    config = parse(
      await readFile(
        path.join(environment.CODEX_HOME ?? path.join(homedir(), ".codex"), "config.toml"),
        "utf8",
      ),
    );
  } catch {
    throw new Error("External voice gateway configuration is unavailable");
  }
  const providers = config.model_providers;
  const provider =
    object(providers) && typeof config.model_provider === "string"
      ? providers[config.model_provider]
      : undefined;
  const token = object(provider)
    ? typeof provider.experimental_bearer_token === "string"
      ? provider.experimental_bearer_token
      : typeof provider.env_key === "string"
        ? environment[provider.env_key]
        : undefined
    : undefined;
  const base = config.experimental_realtime_webrtc_call_base_url;
  const sidebandBase = config.experimental_realtime_ws_base_url ?? base;
  if (typeof base !== "string" || typeof sidebandBase !== "string" || !token)
    throw new Error("External voice requires a configured realtime gateway and API credential");
  let url: URL;
  let sideband: URL;
  try {
    url = new URL(base);
    sideband = new URL(sidebandBase);
  } catch {
    throw new Error("External voice gateway URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    sideband.protocol !== "https:" ||
    url.origin !== sideband.origin ||
    url.username ||
    url.password ||
    sideband.username ||
    sideband.password ||
    url.search ||
    url.hash ||
    sideband.search ||
    sideband.hash
  )
    throw new Error("External voice requires matching HTTPS gateway origins");
  return {
    url,
    sideband,
    token,
    model:
      typeof config.experimental_realtime_ws_model === "string"
        ? config.experimental_realtime_ws_model
        : undefined,
  };
}

type RealtimeGateway = Awaited<ReturnType<typeof readRealtimeGateway>>;

/** Gateway request URLs share one normalized base; only the path suffix differs. */
export function realtimeGatewayUrl(gateway: RealtimeGateway, suffix: string): string {
  return `${gateway.url.href.replace(/\/$/u, "")}${suffix}`;
}

/**
 * Confirms remote cleanup with the configured credential. A 404 means the call is
 * already gone; any other non-OK status leaves cleanup unconfirmed.
 */
export async function hangupRealtimeCall(gateway: RealtimeGateway, callId: string): Promise<void> {
  const response = await fetch(realtimeGatewayUrl(gateway, `/realtime/calls/${callId}/hangup`), {
    method: "POST",
    headers: { Authorization: `Bearer ${gateway.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error("Realtime call hangup unconfirmed");
}
