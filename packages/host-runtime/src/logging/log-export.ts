import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { DiagnosticLogExportResult, DiagnosticLogScope } from "@codexhost/shared-contracts";

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
  destinationDirectory = path.join(os.homedir(), "Downloads"),
): Promise<DiagnosticLogExportResult> {
  const files = (await diagnosticFiles(directory))
    .filter((entry) =>
      scope.kind === "runtime"
        ? entry.scope.kind === "runtime"
        : entry.scope.kind === "harness" && entry.scope.harnessId === scope.harnessId,
    )
    .map((entry) => entry.file);
  if (files.length === 0) throw new Error("No diagnostic logs are available to export");
  await mkdir(destinationDirectory, { recursive: true });
  const label =
    scope.kind === "runtime"
      ? "runtime"
      : `harness-${scope.harnessId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60)}`;
  const archivePath = path.join(
    destinationDirectory,
    `codexhost-diagnostics-${label}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.jsonl.gz`,
  );
  let fileCount = 0;
  async function* contents(): AsyncGenerator<Buffer | string> {
    for (const file of files.sort()) {
      try {
        yield* createReadStream(file);
        yield "\n";
        fileCount += 1;
      } catch (error) {
        // Rotation or retention can remove a file after the directory was listed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const archive = await open(archivePath, "wx", 0o600);
  try {
    await pipeline(Readable.from(contents()), createGzip(), archive.createWriteStream());
    if (fileCount === 0) throw new Error("No diagnostic logs are available to export");
    return { path: archivePath, fileCount, bytes: (await stat(archivePath)).size };
  } catch (error) {
    await rm(archivePath, { force: true });
    throw error;
  }
}
