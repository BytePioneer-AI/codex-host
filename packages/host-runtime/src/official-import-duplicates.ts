import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { StoredThreadSummaryV1 } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";

const IMPORT_INDEX_FILE = "external_agent_session_imports.json";
const IMPORT_INDEX_MAX_BYTES = 32 * 1024 * 1024;
const CLAUDE_PROJECTS_SEGMENT = `${path.sep}.claude${path.sep}projects${path.sep}`;

/** Official Thread ID → seconds when Codex imported the Harness Native Session as that Thread. */
export type OfficialImportTimes = ReadonlyMap<string, number>;

interface ImportRecord {
  sourcePath: string;
  importedThreadId: string;
  importedAt: number;
}

function importRecords(parsed: unknown): ImportRecord[] {
  if (!parsed || typeof parsed !== "object") return [];
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  return records.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { source_path, imported_thread_id, imported_at } = entry as Record<string, unknown>;
    if (
      typeof source_path !== "string" ||
      typeof imported_thread_id !== "string" ||
      typeof imported_at !== "number"
    )
      return [];
    return [
      {
        sourcePath: path.normalize(source_path),
        importedThreadId: imported_thread_id,
        importedAt: imported_at,
      },
    ];
  });
}

/** A missing, oversized, or malformed index means "nothing known to hide". */
async function readImportIndex(codexHome: string): Promise<ImportRecord[]> {
  try {
    const handle = await open(path.join(codexHome, IMPORT_INDEX_FILE), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > IMPORT_INDEX_MAX_BYTES) return [];
      return importRecords(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function nativeSessionIds(record: StoredThreadSummaryV1): string[] {
  return [record.nativeSessionRef, record.importSourceRef].flatMap((ref) =>
    ref ? [ref.nativeSessionId] : [],
  );
}

function sessionFile(record: StoredThreadSummaryV1): string | null {
  const locator = record.nativeSessionRef?.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return null;
  const file = (locator as { sessionFile?: unknown }).sessionFile;
  return typeof file === "string" ? path.normalize(file) : null;
}

function isCodexhostSessionSource(
  source: string,
  sessionFiles: ReadonlySet<string>,
  claudeSessionIds: ReadonlySet<string>,
): boolean {
  if (sessionFiles.has(source)) return true;
  return (
    source.includes(CLAUDE_PROJECTS_SEGMENT) &&
    claudeSessionIds.has(path.basename(source, ".jsonl"))
  );
}

/**
 * Codex can auto-import a Harness Native Session as a second, unrelated official Thread. Find the
 * official Threads that are such imports of Sessions codexhost already lists itself.
 */
export async function readOfficialImportTimes(
  codexHome: string | undefined,
  records: readonly StoredThreadSummaryV1[],
): Promise<OfficialImportTimes> {
  const home = codexHome ?? path.join(homedir(), ".codex");
  const imports = await readImportIndex(home);
  if (imports.length === 0 || records.length === 0) return new Map();
  const sessionFiles = new Set(records.flatMap((record) => sessionFile(record) ?? []));
  const claudeSessionIds = new Set(
    records.filter((record) => record.harnessId === "claude-code").flatMap(nativeSessionIds),
  );
  return new Map(
    imports
      .filter((entry) => isCodexhostSessionSource(entry.sourcePath, sessionFiles, claudeSessionIds))
      .map((entry) => [entry.importedThreadId, entry.importedAt]),
  );
}

/**
 * True for an official import mirror nobody has touched since it was imported. A Thread continued
 * in Codex (`recencyAt` after the import) or placed in a section is the user's own and stays listed.
 */
export function isShadowedOfficialThread(
  importTimes: OfficialImportTimes | undefined,
  thread: JsonObject,
  hasSection = false,
): boolean {
  if (hasSection || typeof thread.id !== "string") return false;
  const importedAt = importTimes?.get(thread.id);
  return (
    importedAt !== undefined &&
    typeof thread.recencyAt === "number" &&
    thread.recencyAt <= importedAt
  );
}
