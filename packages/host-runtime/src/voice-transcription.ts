import { readFile } from "node:fs/promises";
import {
  VOICE_AUDIO_MAX_BYTES,
  voiceFailure,
  voiceTranscribeParamsSchema,
  type VoiceStatusResult,
  type VoiceTranscribeResult,
} from "@codexhost/shared-contracts";
import { readCodexCredentialFile } from "./account/codex-credential-export.js";

const CODEX_VOICE_CLIENT = {
  originator: "Codex Desktop",
  "User-Agent": "Codex Desktop/26.1013.40934 (Mac OS; arm64)",
} as const;

async function readLogin(environment: NodeJS.ProcessEnv) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await readCodexCredentialFile(environment))?.oauth;
    } catch {
      // Codex may be replacing auth.json. Retry only the read, never the HTTP request.
    }
  }
  return undefined;
}

export async function voiceStatus(environment: NodeJS.ProcessEnv): Promise<VoiceStatusResult> {
  return { available: (await readLogin(environment)) !== undefined };
}

/** Account-level input assistance; no Harness or Codex process participates. */
export async function transcribeVoice(
  input: unknown,
  environment: NodeJS.ProcessEnv,
): Promise<VoiceTranscribeResult> {
  const parsed = voiceTranscribeParamsSchema.safeParse(input);
  if (!parsed.success) return voiceFailure("audio-format");
  const { path, mimeType } = parsed.data;
  let audio: Buffer;
  try {
    audio = await readFile(path);
  } catch {
    return voiceFailure("audio-invalid");
  }
  if (!audio.length) return voiceFailure("audio-empty");
  if (audio.length > VOICE_AUDIO_MAX_BYTES) return voiceFailure("audio-too-large");
  const login = await readLogin(environment);
  if (!login?.accountId) return voiceFailure("credentials-unavailable");
  if (login.expires <= Date.now()) return voiceFailure("login-expired");
  const form = new FormData();
  const extension = mimeType.startsWith("audio/mp4") ? "m4a" : mimeType.split(/[\/;]/)[1];
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${extension}`);
  const signal = AbortSignal.timeout(90_000);
  try {
    const response = await fetch("https://chatgpt.com/backend-api/transcribe", {
      method: "POST",
      headers: {
        ...CODEX_VOICE_CLIENT,
        Authorization: `Bearer ${login.access}`,
        "ChatGPT-Account-Id": login.accountId,
        Accept: "application/json",
      },
      body: form,
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return voiceFailure("login-expired");
      if (response.status === 429) return voiceFailure("rate-limited");
      if ([400, 415, 422].includes(response.status)) return voiceFailure("audio-format");
      return voiceFailure("service-rejected");
    }
    const body: unknown = await response.json();
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string") return voiceFailure("service-rejected");
    if (!text.trim()) return voiceFailure("audio-empty");
    return { ok: true, text };
  } catch {
    return voiceFailure(signal.aborted ? "timeout" : "network");
  }
}
