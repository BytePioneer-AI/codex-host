import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { findClaudeTranscript } from "./claude-transcript.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(line: string): Record<string, unknown> | null {
  if (line.trim().length === 0) return null;
  try {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** Rewrites `sameAs` values in place and returns how many changed. */
function remapSameAs(value: unknown, copies: ReadonlyMap<string, string>): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((count, item) => count + remapSameAs(item, copies), 0);
  }
  if (!isRecord(value)) return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    const copy = key === "sameAs" && typeof child === "string" ? copies.get(child) : undefined;
    if (copy) {
      value[key] = copy;
      count += 1;
    } else {
      count += remapSameAs(child, copies);
    }
  }
  return count;
}

/**
 * The Agent SDK's forkSession() gives every copied entry a fresh UUID and records the source UUID
 * in `forkedFrom.messageUuid`, but leaves attachment `sameAs` references (a re-surfaced deferred
 * Tool naming the entry that holds its definition) on source UUIDs. Claude Code cannot resolve
 * them in the derived Session, so the history it sends differs from the source Session's and the
 * first request after the Fork misses the prompt cache. This points them at the copied entries.
 * Must run before any Claude Code process opens the derived Session. Returns the rewritten count.
 */
export async function remapForkedSessionReferences(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
}): Promise<number> {
  const transcript = await findClaudeTranscript(input);
  if (!transcript) return 0;
  const contents = await readFile(transcript, "utf8");
  if (!contents.includes('"sameAs"')) return 0;

  const lines = contents.split("\n");
  const entries = lines.map(parseEntry);
  const copies = new Map<string, string>();
  for (const entry of entries) {
    const source = entry?.forkedFrom;
    if (
      typeof entry?.uuid === "string" &&
      isRecord(source) &&
      typeof source.messageUuid === "string"
    ) {
      copies.set(source.messageUuid, entry.uuid);
    }
  }
  let remapped = 0;
  const output = lines.map((line, index) => {
    const entry = entries[index];
    // Message content is conversation data, never a reference; only attachments carry `sameAs`.
    if (entry?.type !== "attachment") return line;
    const count = remapSameAs(entry.attachment, copies);
    if (count === 0) return line;
    remapped += count;
    return JSON.stringify(entry);
  });
  if (remapped === 0) return 0;

  // Replace atomically so a failure leaves the SDK's copy intact.
  const temporary = `${transcript}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output.join("\n"), {
      flag: "wx",
      mode: (await stat(transcript)).mode & 0o777,
    });
    await rename(temporary, transcript);
  } finally {
    await rm(temporary, { force: true });
  }
  return remapped;
}
