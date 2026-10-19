import WebSocket from "ws";
import {
  hangupRealtimeCall,
  readRealtimeGateway,
  realtimeGatewayUrl,
} from "./realtime-gateway-config.js";
import { isRealtimeCallId, realtimeCallIdFromLocation } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";

export interface ExternalVoiceCall {
  sdp: string;
  /** Opens control only after the Host has sent the SDP answer to Desktop. */
  connect(): Promise<void>;
  send(event: JsonObject): void;
  close(): Promise<void>;
}

export type ExternalVoiceCallFactory = (input: {
  sdp: string;
  /** A Desktop-owned call already created through the configured gateway. */
  callId?: string;
  voice?: string;
  signal: AbortSignal;
  /** Prior Thread messages for GPT-Live `session.initial_items`; omitted when empty. */
  input?: JsonObject[];
  onEvent(event: JsonObject): void;
  onError(): void;
}) => Promise<ExternalVoiceCall>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the configured gateway; never borrow OAuth from auth.json. */
export function configuredExternalVoiceGateway(
  environment: NodeJS.ProcessEnv,
): ExternalVoiceCallFactory {
  return async (input) => {
    const gateway = await readRealtimeGateway(environment);
    const { sideband, token, model } = gateway;
    const headers = { Authorization: `Bearer ${token}`, "OpenAI-Alpha": "quicksilver=v2" };
    if (input.callId !== undefined && !isRealtimeCallId(input.callId))
      throw new Error("External voice call identity is invalid");
    let callId: string | undefined = input.callId;
    let response: Response | undefined;
    if (callId === undefined) {
      const form = new FormData();
      form.append("sdp", input.sdp);
      form.append(
        "session",
        JSON.stringify({
          model: model ?? "gpt-realtime",
          instructions:
            "Use natural Hong Kong Cantonese. Delegate every user question and task to the client, including simple arithmetic. " +
            "The client agent owns all reasoning and task execution. Do not answer questions yourself or invent task results. " +
            "Speak only verified client results; do not read private reasoning or machine identifiers.",
          audio: { output: { voice: input.voice ?? "cove" } },
          delegation: { type: "client", ack_filler: false },
          ...(input.input && input.input.length > 0 ? { initial_items: input.input } : {}),
        }),
      );
      response = await fetch(realtimeGatewayUrl(gateway, "/realtime/calls"), {
        method: "POST",
        headers,
        body: form,
        redirect: "error",
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("External voice call creation failed");
      callId = realtimeCallIdFromLocation(response.headers.get("location") ?? "");
      if (!callId) {
        await response?.body?.cancel().catch(() => undefined);
        throw new Error(
          "External voice call identity is unavailable; remote cleanup is unconfirmed",
        );
      }
    }
    let socket: WebSocket | undefined;
    let closed = false;
    let closeTask: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closeTask ??= (async () => {
        closed = true;
        socket?.terminate();
        try {
          await hangupRealtimeCall(gateway, callId);
        } catch {
          throw new Error("External voice hangup was not confirmed");
        }
      })());
    try {
      const sdp = response ? await response.text() : "";
      if (input.signal.aborted) {
        await close();
        throw new Error("External voice start cancelled");
      }
      return {
        sdp,
        async connect() {
          if (closed || input.signal.aborted) throw new Error("External voice call is closed");
          sideband.protocol = "wss:";
          sideband.pathname = `${sideband.pathname.replace(/\/$/u, "")}/live/${callId}`;
          const options: WebSocket.ClientOptions & { autoSelectFamily: boolean } = {
            headers,
            autoSelectFamily: true,
            handshakeTimeout: 12_000,
            maxPayload: 1 << 20,
          };
          const connection = new WebSocket(sideband, options);
          socket = connection;
          connection.on("error", () => {
            if (!closed) input.onError();
          });
          connection.on("close", () => {
            if (!closed) input.onError();
          });
          connection.on("message", (raw) => {
            if (closed || input.signal.aborted) return;
            try {
              const event: unknown = JSON.parse(String(raw));
              if (object(event) && typeof event.type === "string")
                input.onEvent(event as JsonObject);
            } catch {
              input.onError();
            }
          });
          await new Promise<void>((resolve, reject) => {
            connection.once("open", resolve);
            connection.once("error", () =>
              reject(new Error("External voice control connection failed")),
            );
          });
          if (closed) throw new Error("External voice call is closed");
        },
        send(event) {
          if (closed || socket?.readyState !== WebSocket.OPEN)
            throw new Error("External voice control connection is unavailable");
          socket.send(JSON.stringify(event));
        },
        close,
      };
    } catch {
      await close();
      throw new Error("External voice call startup failed");
    }
  };
}
