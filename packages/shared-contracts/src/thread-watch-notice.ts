/**
 * Thread watch notice: the message a watch sends into the notified Thread.
 *
 * The same text is read by the model, shown by Codex Desktop with each watched
 * Thread as its native `[title](thread://<id>)` session mention, and folded by
 * Web into a notice card. Text that does not parse stays an ordinary
 * user message.
 */
/**
 * Wakes the notified Thread's agent: each entry states its outcome, so the
 * header only asks it to judge the actual work and carry on with its task.
 */
export const THREAD_WATCH_NOTICE_HEADER =
  "[codexhost thread watch] Read each Thread's result, then continue your task:";

export const THREAD_WATCH_NOTICE_OUTCOMES = [
  "completed",
  "failed",
  "interrupted",
  "needsInput",
  "timedOut",
  "unreadable",
  "notFound",
] as const;

export type ThreadWatchNoticeOutcome = (typeof THREAD_WATCH_NOTICE_OUTCOMES)[number];

export interface ThreadWatchNoticeEntry {
  threadId: string;
  /** Link label: the Thread title when known, otherwise the Thread id. */
  label: string;
  outcome: ThreadWatchNoticeOutcome;
  /** One-line explanation, such as why the outcome is uncertain. */
  note?: string;
}

const ENTRY_PATTERN = new RegExp(
  String.raw`^- \[([^\]\n]+)\]\(thread://([^\s()<>"?#/]+)\): ` +
    `(${THREAD_WATCH_NOTICE_OUTCOMES.join("|")})(?:\. (.+))?$`,
  "u",
);

function oneLine(value: string, forbidden: RegExp): string {
  return value.replace(forbidden, " ").replace(/\s+/gu, " ").trim();
}

function formatEntry(entry: ThreadWatchNoticeEntry): string {
  const label = oneLine(entry.label, /[[\]]/gu) || entry.threadId;
  const note = entry.note ? oneLine(entry.note, /\n/gu) : "";
  return `- [${label}](thread://${entry.threadId}): ${entry.outcome}${note ? `. ${note}` : ""}`;
}

export function formatThreadWatchNotice(entries: readonly ThreadWatchNoticeEntry[]): string {
  return [THREAD_WATCH_NOTICE_HEADER, "", ...entries.map(formatEntry)].join("\n");
}

/** Entries of a well-formed notice; undefined for any other text. */
export function parseThreadWatchNotice(text: string): ThreadWatchNoticeEntry[] | undefined {
  const [header, ...lines] = text.trim().split(/\r?\n/u);
  if (header !== THREAD_WATCH_NOTICE_HEADER) return undefined;
  const entries: ThreadWatchNoticeEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = ENTRY_PATTERN.exec(line);
    if (!match) return undefined;
    const [, label = "", threadId = "", outcome, note] = match;
    entries.push({
      threadId,
      label,
      outcome: outcome as ThreadWatchNoticeOutcome,
      ...(note ? { note } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}
