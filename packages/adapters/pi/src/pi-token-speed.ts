import { stripVTControlCharacters } from "node:util";

/** Read pi-token-speed's native status; never estimate speed from Host timings. */
export function parsePiTokenSpeedStatus(
  value: Record<string, unknown>,
): { outputTokensPerSecond?: number } | null {
  if (
    value.type !== "extension_ui_request" ||
    value.method !== "setStatus" ||
    value.statusKey !== "tokenSpeed"
  )
    return null;
  if (value.statusText === undefined || value.statusText === "") return {};
  if (typeof value.statusText !== "string") return null;
  const text = stripVTControlCharacters(value.statusText);
  if (/TPS:\s*--(?:\s|$)/u.test(text)) return {};
  const match = /TPS:\s*(\d+(?:\.\d+)?)\s+tok\/s(?:\s|\u200b|$)/u.exec(text);
  if (!match) return null;
  const outputTokensPerSecond = Number(match[1]);
  return Number.isFinite(outputTokensPerSecond) ? { outputTokensPerSecond } : null;
}
