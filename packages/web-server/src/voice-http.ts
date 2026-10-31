/** Raw audio transport; main.ts applies the shared Web auth and same-origin gates. */
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  VOICE_AUDIO_MAX_BYTES,
  voiceAudioMimeTypeSchema,
  voiceFailure,
  voiceTranscribeResultSchema,
  voiceStatusResultSchema,
  type VoiceTranscribeResult,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

type VoiceHost = Pick<ChHostClient, "request">;

export function registerVoiceStatus(rpc: RpcRegistry, host: VoiceHost): void {
  rpc.register("codexhost/voice/status", async () => {
    try {
      return voiceStatusResultSchema.parse(await host.request("codexhost/voice/status", {}));
    } catch {
      return { available: false };
    }
  });
}

/** An unknown method or parameters means an older Host; any other failure is reported as network. */
function hostIncompatible(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  if (error.code === "host/method-unavailable") return true;
  const code = (error.details as { hostCode?: unknown }).hostCode;
  return error.code === "host/rejected" && (code === -32601 || code === -32602);
}

export async function serveVoiceTranscription(
  host: VoiceHost,
  dataRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // The Host call cannot be cancelled; a gone client only skips the reply.
  const send = (status: number, result: VoiceTranscribeResult) => {
    if (!response.destroyed)
      response
        .writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(JSON.stringify(result));
  };
  let path: string | undefined;
  try {
    const mimeType = request.headers["content-type"] ?? "";
    if (!voiceAudioMimeTypeSchema.safeParse(mimeType).success) {
      send(415, voiceFailure("audio-format"));
      return;
    }
    if (Number(request.headers["content-length"]) > VOICE_AUDIO_MAX_BYTES) {
      send(413, voiceFailure("audio-too-large"));
      return;
    }
    const directory = join(dataRoot, "voice");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    path = join(directory, randomUUID());
    const file = await open(path, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > VOICE_AUDIO_MAX_BYTES) {
          send(413, voiceFailure("audio-too-large"));
          return;
        }
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (!size) {
      send(400, voiceFailure("audio-empty"));
      return;
    }
    let result: unknown;
    try {
      result = await host.request("codexhost/voice/transcribe", { path, mimeType });
    } catch (error) {
      send(200, voiceFailure(hostIncompatible(error) ? "host-incompatible" : "network"));
      return;
    }
    const parsed = voiceTranscribeResultSchema.safeParse(result);
    send(200, parsed.success ? parsed.data : voiceFailure("host-incompatible"));
  } catch {
    send(200, voiceFailure("network"));
  } finally {
    if (path) await rm(path, { force: true });
    request.resume();
  }
}
