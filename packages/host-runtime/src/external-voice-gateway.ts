import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import WebSocket from "ws";
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
  voice?: string;
  signal: AbortSignal;
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
    if (typeof base !== "string" || typeof sidebandBase !== "string" || !token) {
      throw new Error("External voice requires a configured realtime gateway and API credential");
    }
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
    const headers = { Authorization: `Bearer ${token}`, "OpenAI-Alpha": "quicksilver=v2" };
    const form = new FormData();
    form.append("sdp", input.sdp);
    form.append(
      "session",
      JSON.stringify({
        model:
          typeof config.experimental_realtime_ws_model === "string"
            ? config.experimental_realtime_ws_model
            : "gpt-realtime",
        instructions:
          "Use natural Hong Kong Cantonese. Delegate every user question and task to the client, including simple arithmetic. " +
          "The client agent owns all reasoning and task execution. Do not answer questions yourself or invent task results. " +
          "Speak only verified client results; do not read private reasoning or machine identifiers.",
        audio: { output: { voice: input.voice ?? "cove" } },
        delegation: { type: "client", ack_filler: false },
      }),
    );
    const response = await fetch(`${url.href.replace(/\/$/u, "")}/realtime/calls`, {
      method: "POST",
      headers,
      body: form,
      redirect: "error",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error("External voice call creation failed");
    const location = response.headers.get("location");
    let callId: string | undefined;
    try {
      if (location)
        callId = new URL(location, url).pathname.match(
          /\/(?:calls|live)\/([A-Za-z0-9_-]{1,128})$/u,
        )?.[1];
    } catch {
      // Without a valid identity there is no safe remote hangup target.
    }
    if (!callId) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("External voice call identity is unavailable; remote cleanup is unconfirmed");
    }
    let socket: WebSocket | undefined;
    let closed = false;
    let closeTask: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closeTask ??= (async () => {
        closed = true;
        socket?.terminate();
        const result = await fetch(
          `${url.href.replace(/\/$/u, "")}/realtime/calls/${callId}/hangup`,
          {
            method: "POST",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!result.ok && result.status !== 404)
          throw new Error("External voice hangup was not confirmed");
      })());
    try {
      const sdp = await response.text();
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
