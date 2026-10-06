import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { DiagnosticLogExportResult, DiagnosticLogScope } from "@codexhost/shared-contracts";

const gzipAsync = promisify(gzip);
export const DIAGNOSTIC_LOG_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

async function threadHarness(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, "utf8");
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      return typeof record === "object" &&
        record !== null &&
        "harnessId" in record &&
        typeof record.harnessId === "string" &&
        record.harnessId.length > 0
        ? record.harnessId
        : undefined;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

async function diagnosticFiles(
  directory: string,
): Promise<{ file: string; scope: DiagnosticLogScope }[]> {
  const files: { file: string; scope: DiagnosticLogScope }[] = [];
  for (const category of ["threads", "runtime"]) {
    const source = path.join(directory, category);
    const entries = await readdir(source, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const file = path.join(source, entry.name);
        if (category === "runtime") files.push({ file, scope: { kind: "runtime" } });
        else {
          const harnessId = await threadHarness(file);
          if (harnessId) files.push({ file, scope: { kind: "harness", harnessId } });
        }
      }
    }
  }
  return files;
}

export async function listDiagnosticLogs(directory: string): Promise<DiagnosticLogScope[]> {
  const scopes = new Map<string, DiagnosticLogScope>();
  for (const { scope } of await diagnosticFiles(directory)) {
    scopes.set(scope.kind === "runtime" ? "runtime" : `harness:${scope.harnessId}`, scope);
  }
  return [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, scope]) => scope);
}

/** Exports only the selected Harness or runtime logs, never credentials or raw transcripts. */
export async function exportDiagnosticLogs(
  directory: string,
  scope: DiagnosticLogScope,
): Promise<DiagnosticLogExportResult> {
  const files = (await diagnosticFiles(directory))
    .filter((entry) =>
      scope.kind === "runtime"
        ? entry.scope.kind === "runtime"
        : entry.scope.kind === "harness" && entry.scope.harnessId === scope.harnessId,
    )
    .map((entry) => entry.file);
  if (files.length === 0) throw new Error("No diagnostic logs are available to export");
  const label =
    scope.kind === "runtime"
      ? "runtime"
      : `harness-${scope.harnessId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60)}`;
  const fileName = `codexhost-diagnostics-${label}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.jsonl.gz`;
  const selectedFiles: string[] = [];
  let selectedBytes = 0;
  for (const file of files.sort()) {
    try {
      const size = (await stat(file)).size;
      if (selectedBytes + size > DIAGNOSTIC_LOG_EXPORT_MAX_BYTES) {
        throw new Error("Selected diagnostic logs exceed the 32 MiB export limit");
      }
      selectedBytes += size;
      selectedFiles.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let fileCount = 0;
  const contents: Buffer[] = [];
  let actualBytes = 0;
  for (const file of selectedFiles) {
    try {
      const content = await readFile(file);
      actualBytes += content.length;
      if (actualBytes > DIAGNOSTIC_LOG_EXPORT_MAX_BYTES) {
        throw new Error("Selected diagnostic logs exceed the 32 MiB export limit");
      }
      contents.push(content, Buffer.from("\n"));
      fileCount += 1;
    } catch (error) {
      // Rotation or retention can remove a file after the directory was listed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (fileCount === 0) throw new Error("No diagnostic logs are available to export");
  const archive = await gzipAsync(Buffer.concat(contents));
  return { fileName, data: archive.toString("base64"), fileCount, bytes: archive.length };
}
