import { createHash } from "node:crypto";

import { hostItemIdSchema, type HostItemId } from "@codexhost/shared-contracts";

export interface PiProgressMessage {
  type: "progress.message";
  itemId: HostItemId;
  text: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export function boundedPiProgress(text: string): string {
  const limit = 64_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Pi notification truncated]`;
}

function visibleText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function noticeDisplay(value: unknown, fallback: string): string {
  if (!record(value) || !record(value.details) || typeof value.details.summary !== "string")
    return visibleText(fallback);
  const details = value.details;
  const parts = [visibleText(details.summary as string)];
  if (typeof details.exitCode === "number") parts.push(`Exit code: ${details.exitCode}`);
  for (const key of ["signal", "error", "errorMessage"])
    if (typeof details[key] === "string" && details[key])
      parts.push(`${key}: ${visibleText(details[key])}`);
  if (record(details.logMatch) && typeof details.logMatch.line === "string")
    parts.push(`Log: ${visibleText(details.logMatch.line)}`);
  if (typeof details.command === "string" && details.command)
    parts.push(`Command: ${visibleText(details.command)}`);
  return parts.join("\n\n");
}

/** Pi persists custom messages with a new timestamp, so timestamps cannot identify them. */
export function piCustomNoticeKey(value: unknown): string | null {
  if (
    !record(value) ||
    (value.type !== "custom_message" && value.role !== "custom") ||
    value.display !== true ||
    typeof value.customType !== "string"
  )
    return null;
  const text = textContent(value.content);
  if (text.trim().length === 0) return null;
  return JSON.stringify([value.customType, text]);
}

export function piCustomNotice(
  value: unknown,
  sessionId: string,
  occurrences: Map<string, number>,
): PiProgressMessage | null {
  const key = piCustomNoticeKey(value);
  if (!key) return null;
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionId, key, occurrence]))
    .digest("hex");
  const [customType, text] = JSON.parse(key) as [string, string];
  return {
    type: "progress.message",
    itemId: hostItemIdSchema.parse(`pi-notice-v1-${digest}`),
    text: boundedPiProgress(
      `Pi notification (${visibleText(customType)})\n\n${noticeDisplay(value, text)}`,
    ),
  };
}

export function piHistoryNotices(
  sessionId: string,
  entries: readonly { id: string; message?: unknown }[],
): { notices: Map<string, PiProgressMessage>; occurrences: Map<string, number> } {
  const occurrences = new Map<string, number>();
  const notices = new Map<string, PiProgressMessage>();
  for (const entry of entries) {
    const notice = piCustomNotice(entry.message ?? entry, sessionId, occurrences);
    if (notice) notices.set(entry.id, notice);
  }
  return { notices, occurrences };
}

/** Non-persisted native status is deliberately distinct from Assistant answer text. */
export function piStatusText(value: Record<string, unknown>): string | null {
  if (value.type === "auto_retry_start") {
    const attempt = typeof value.attempt === "number" ? ` ${value.attempt}` : "";
    const maximum = typeof value.maxAttempts === "number" ? `/${value.maxAttempts}` : "";
    const delay =
      typeof value.delayMs === "number" && value.delayMs >= 0
        ? ` Waiting ${value.delayMs / 1000} s before retrying.`
        : "";
    const reason =
      typeof value.errorMessage === "string" ? `\n\n${visibleText(value.errorMessage)}` : "";
    return boundedPiProgress(`Pi retry${attempt}${maximum}.${delay}${reason}`);
  }
  if (value.type === "auto_retry_end") {
    if (typeof value.success !== "boolean") return null;
    const reason =
      typeof value.finalError === "string" ? `\n\n${visibleText(value.finalError)}` : "";
    return boundedPiProgress(
      `Pi retry ${value.success ? "succeeded" : "ended without success"}.${reason}`,
    );
  }
  if (value.type !== "extension_ui_request") return null;
  if (value.method === "notify" && typeof value.message === "string" && value.message.trim()) {
    const level = typeof value.notifyType === "string" ? ` (${value.notifyType})` : "";
    return boundedPiProgress(`Pi notification${level}\n\n${visibleText(value.message)}`);
  }
  if (value.method === "setStatus" && typeof value.statusKey === "string") {
    return typeof value.statusText === "string" && value.statusText.trim()
      ? boundedPiProgress(
          `Pi status (${visibleText(value.statusKey)})\n\n${visibleText(value.statusText)}`,
        )
      : `Pi status (${visibleText(value.statusKey)}) cleared.`;
  }
  return null;
}
