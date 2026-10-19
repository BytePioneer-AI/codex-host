import { z } from "zod";

export const REALTIME_CALL_METHOD = "codexhost/realtime/call";

/**
 * Native voice headers the Host may forward to the configured gateway. Anything
 * else — Desktop OAuth, ChatGPT account identity and cookies — is dropped at the
 * Renderer bridge and again at the Host before the outbound request.
 */
export const REALTIME_CALL_FORWARDED_HEADERS: readonly string[] = [
  "openai-alpha",
  "thread-id",
  "session-id",
  "originator",
  "x-codex-turn-metadata",
];
const FORWARDED_HEADERS = new Set(REALTIME_CALL_FORWARDED_HEADERS);

/** Keeps only allowlisted headers with a usable value; all other names are dropped. */
export function filterRealtimeCallHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (FORWARDED_HEADERS.has(key) && value.length > 0 && value.length <= 4096) result[key] = value;
  }
  return result;
}

/** The single accepted identity form for a gateway-created realtime call. */
export const REALTIME_CALL_ID_PATTERN = /^rtc_[A-Za-z0-9_-]{1,128}$/u;

export function isRealtimeCallId(value: unknown): value is string {
  return typeof value === "string" && REALTIME_CALL_ID_PATTERN.test(value);
}

/**
 * Reads the created call identity from a gateway `Location` response header: a bare
 * identity, or the trailing segment after `/calls/` or `/live/`, ignoring any query
 * string or fragment. Callers that require the strict `rtc_` form check the result
 * with {@link isRealtimeCallId}.
 */
export function realtimeCallIdFromLocation(location: string): string | undefined {
  const path = location.split(/[?#]/u)[0] ?? "";
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(path)) return path;
  return /\/(?:calls|live)\/([A-Za-z0-9_-]{1,128})$/u.exec(path)?.[1];
}

const requestId = z.string().min(1).max(128);
export const realtimeCallParamsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    requestId,
    body: z
      .string()
      .min(1)
      .max(16 << 20),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ operation: z.literal("cancel"), requestId }),
  z.object({
    operation: z.literal("hangup"),
    callId: z.string().regex(REALTIME_CALL_ID_PATTERN),
  }),
]);
export const realtimeCallResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
});
