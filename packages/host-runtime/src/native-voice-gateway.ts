import {
  filterRealtimeCallHeaders,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
  realtimeCallParamsSchema,
} from "@codexhost/shared-contracts";
import {
  hangupRealtimeCall,
  readRealtimeGateway,
  realtimeGatewayUrl,
} from "./realtime-gateway-config.js";

const RESPONSE_HEADERS = ["content-type", "location", "retry-after"];
const MAX_RESPONSE_BYTES = 16 << 20;
const MAX_PENDING_CALLS = 16;

/** The `create` body must carry the native SDP offer and session object. */
function createCallBody(value: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("Invalid voice call request");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("sdp" in payload) ||
    typeof payload.sdp !== "string" ||
    !("session" in payload) ||
    !payload.session ||
    typeof payload.session !== "object"
  )
    throw new Error("Invalid voice call request");
  return value;
}

/** Serves Desktop-owned call creation using the configured gateway credential. */
export class NativeVoiceGateway {
  readonly #pending = new Map<string, AbortController>();
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  close(): void {
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear();
  }

  async request(value: unknown) {
    const params = realtimeCallParamsSchema.parse(value);
    if (params.operation === "cancel") {
      this.#pending.get(params.requestId)?.abort();
      return { status: 204, body: "", headers: {} };
    }
    if (params.operation === "hangup") {
      const gateway = await readRealtimeGateway(this.environment);
      await hangupRealtimeCall(gateway, params.callId);
      return { status: 204, body: "", headers: {} };
    }
    if (this.#pending.has(params.requestId) || this.#pending.size >= MAX_PENDING_CALLS)
      throw new Error("Voice call creation is already pending");
    const controller = new AbortController();
    this.#pending.set(params.requestId, controller);
    try {
      return await this.#create(params.body, params.headers, controller);
    } finally {
      this.#pending.delete(params.requestId);
    }
  }

  async #create(
    body: string,
    forwarded: Record<string, string>,
    controller: AbortController,
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    // Validated before the transport try, so these stay specific for direct callers.
    const payload = createCallBody(body);
    const gateway = await readRealtimeGateway(this.environment);
    const headers = new Headers({
      Authorization: `Bearer ${gateway.token}`,
      "Content-Type": "application/json",
    });
    for (const [name, value] of Object.entries(filterRealtimeCallHeaders(forwarded)))
      headers.set(name, value);
    let closeCreatedCall: (() => Promise<void>) | undefined;
    try {
      controller.signal.throwIfAborted();
      const response = await fetch(realtimeGatewayUrl(gateway, "/realtime/calls"), {
        method: "POST",
        headers,
        body: payload,
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (response.ok) {
        const callId = realtimeCallIdFromLocation(response.headers.get("location") ?? "");
        if (!isRealtimeCallId(callId)) {
          await response.body?.cancel();
          throw new Error("Voice call identity is unavailable; remote cleanup is unconfirmed");
        }
        closeCreatedCall = () => hangupRealtimeCall(gateway, callId);
      }
      const resultHeaders: Record<string, string> = {};
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) resultHeaders[name] = value;
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("Voice gateway response is too large");
      controller.signal.throwIfAborted();
      return { status: response.status, body: text, headers: resultHeaders };
    } catch (error) {
      if (closeCreatedCall) {
        try {
          await closeCreatedCall();
        } catch {
          throw new Error("Voice gateway startup failed; remote cleanup is unconfirmed");
        }
      }
      if (controller.signal.aborted) throw new Error("Voice call creation cancelled");
      // Transport diagnostics must not expose headers, credentials or SDP.
      if (error instanceof Error && /^(Invalid voice|Voice call identity)/u.test(error.message))
        throw error;
      throw new Error("Configured voice gateway request failed");
    }
  }
}
