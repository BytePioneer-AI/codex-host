import { consoleAnnouncementSchema, type ConsoleAnnouncement } from "@codexhost/shared-contracts";

const ANNOUNCEMENT_URL =
  "https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/docs/NOTICE.md";
const MAX_DOCUMENT_BYTES = 16 * 1024;
const TIMEOUT_MS = 5_000;

/** Deliberately limited front matter: three scalar fields, not general YAML. */
export function parseAnnouncement(document: string): ConsoleAnnouncement | null {
  if (Buffer.byteLength(document) > MAX_DOCUMENT_BYTES) return null;
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(
    document.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n"),
  );
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    if (!line.trim()) continue;
    const field = /^(enabled|title|type):[ \t]*(.+?)\s*$/u.exec(line);
    if (!field?.[1] || !field[2] || fields.has(field[1])) return null;
    fields.set(field[1], field[2]);
  }
  if (fields.get("enabled") !== "true") return null;
  let title = fields.get("title");
  if (title?.startsWith('"')) {
    try {
      title = JSON.parse(title) as string;
    } catch {
      return null;
    }
  }
  const parsed = consoleAnnouncementSchema.safeParse({
    title,
    type: fields.get("type"),
    body: match[2],
  });
  return parsed.success ? parsed.data : null;
}

async function download(fetcher: typeof fetch): Promise<ConsoleAnnouncement | null> {
  const response = await fetcher(ANNOUNCEMENT_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
    cache: "no-store",
    headers: { accept: "text/plain" },
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    // Returning closes the iterator and cancels the response stream.
    if (size > MAX_DOCUMENT_BYTES) return null;
    chunks.push(chunk);
  }
  return parseAnnouncement(Buffer.concat(chunks).toString("utf8"));
}

/** One bounded request per page load; no cached failures or background retries. */
export function readAnnouncement(
  fetcher: typeof fetch = fetch,
): Promise<ConsoleAnnouncement | null> {
  return download(fetcher).catch(() => null);
}
