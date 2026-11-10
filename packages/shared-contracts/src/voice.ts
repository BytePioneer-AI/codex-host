import { z } from "zod";

export const VOICE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const voiceAudioMimeTypeSchema = z.string().regex(/^audio\/[a-z0-9.+-]+(?:\s*;[^\r\n]*)?$/i);
export const voiceStatusResultSchema = z.object({ available: z.boolean() }).strict();
export const voiceTranscribeParamsSchema = z
  .object({ path: z.string().min(1), mimeType: voiceAudioMimeTypeSchema })
  .strict();
export const voiceErrorCodeSchema = z.enum([
  "credentials-unavailable",
  "login-expired",
  "rate-limited",
  "service-rejected",
  "host-incompatible",
  "network",
  "timeout",
  "audio-empty",
  "audio-too-large",
  "audio-format",
  "audio-invalid",
]);
/** Codes only: user-facing copy belongs to the client's locale dictionaries. */
export const voiceTranscribeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z
    .object({ ok: z.literal(false), error: z.object({ code: voiceErrorCodeSchema }).strict() })
    .strict(),
]);
export type VoiceStatusResult = z.infer<typeof voiceStatusResultSchema>;
export type VoiceTranscribeParams = z.infer<typeof voiceTranscribeParamsSchema>;
export type VoiceTranscribeResult = z.infer<typeof voiceTranscribeResultSchema>;
export type VoiceErrorCode = z.infer<typeof voiceErrorCodeSchema>;

export function voiceFailure(code: VoiceErrorCode): Extract<VoiceTranscribeResult, { ok: false }> {
  return { ok: false, error: { code } };
}
