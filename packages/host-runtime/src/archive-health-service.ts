import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ArchiveHealthInconsistentThread,
  ArchiveHealthProcess,
  ArchiveHealthResult,
  ArchiveForceResult,
} from "@codexhost/shared-contracts";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import type { ExternalThreadRuntime } from "./external-thread-runtime.js";

const execFileAsync = promisify(execFile);

export class ArchiveHealthError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveHealthError";
  }
}

export interface ArchiveHealthServiceOptions {
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
  notifyArchived(threadId: string): Promise<void>;
  listOfficialProcesses?(): Promise<Array<{ pid: number; command: string }>>;
}

export async function defaultListCodexProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  try {
    const isWindows = process.platform === "win32";
    if (isWindows) {
      const { stdout } = await execFileAsync("wmic", [
        "process",
        "where",
        "name like '%codex%'",
        "get",
        "ProcessId,CommandLine",
        "/format:csv",
      ]);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const results: Array<{ pid: number; command: string }> = [];
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length >= 3) {
          const command = parts[1]?.trim() ?? "";
          const pid = Number.parseInt(parts[2]?.trim() ?? "", 10);
          if (
            Number.isInteger(pid) &&
            pid !== process.pid &&
            !command.toLowerCase().includes("codexhost")
          ) {
            results.push({ pid, command });
          }
        }
      }
      return results;
    }

    const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
    const lines = stdout.split("\n");
    const results: Array<{ pid: number; command: string }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("PID")) continue;
      const match = /^(\d+)\s+(.+)$/.exec(trimmed);
      if (!match) continue;
      const pid = Number.parseInt(match[1] ?? "", 10);
      const command = match[2] ?? "";
      const lower = command.toLowerCase();
      // Match codex CLI processes, but ignore codexhost daemon, wrappers, grep, and current process
      if (
        Number.isInteger(pid) &&
        pid !== process.pid &&
        (lower.includes("codex ") ||
          lower.endsWith("/codex") ||
          lower.includes("codex-cli") ||
          lower.includes("codex.js")) &&
        !lower.includes("codexhost") &&
        !lower.includes("codex-host")
      ) {
        results.push({ pid, command });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export class ArchiveHealthService {
  constructor(private readonly options: ArchiveHealthServiceOptions) {}

  async inspect(): Promise<ArchiveHealthResult> {
    const inconsistentThreads: ArchiveHealthInconsistentThread[] = [];

    // 1. Inspect external threads from repository and runtime
    const repositoryThreads = await this.options.repository.list().catch(() => []);
    const inMemoryThreads = this.options.runtime.values();

    // Check all repository records
    for (const record of repositoryThreads) {
      const thread = this.options.runtime.get(record.hostThreadId);
      const failure = thread ? this.options.runtime.idleRelease.failure(thread) : undefined;

      if (failure) {
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: "failed",
          reason: failure,
          recoverable: true,
          hint: "Release failed. Run safe force-archive to mark archived in MappingStore and detach session.",
        });
      } else if (thread?.sessionUnavailable) {
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: "unavailable",
          reason: "Harness session unavailable or faulted",
          recoverable: true,
          hint: "Session unavailable. Run safe force-archive to cleanly archive.",
        });
      } else if (record.state !== "ready") {
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: record.state,
          reason: "Provisional uncommitted thread record",
          recoverable: true,
          hint: "Provisional record was never committed. Safe to force-archive.",
        });
      } else if (record.archived && thread && !thread.record.archived) {
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: "inconsistent",
          reason: "MappingStore marked archived but runtime instance still unarchived",
          recoverable: true,
          hint: "Run safe force-archive to sync runtime and detach.",
        });
      }
    }

    // Check in-memory threads not found in repository (orphaned runtime entries)
    for (const thread of inMemoryThreads) {
      const found = repositoryThreads.some((r) => r.hostThreadId === thread.id);
      if (!found) {
        inconsistentThreads.push({
          threadId: thread.id,
          title: thread.record.title ?? null,
          harnessId: thread.harnessId ?? null,
          kind: "external",
          state: "orphaned",
          reason: "In-memory thread has no corresponding record in MappingStore",
          recoverable: true,
          hint: "Detach orphaned in-memory instance via force-archive.",
        });
      }
    }

    // 2. Inspect official Codex processes
    const listProcesses = this.options.listOfficialProcesses ?? defaultListCodexProcesses;
    const rawProcesses = await listProcesses();
    const officialProcesses: ArchiveHealthProcess[] = rawProcesses.map((p) => ({
      pid: p.pid,
      command: p.command,
      hint: `Process PID ${p.pid} is running: '${p.command}'. Terminate it (e.g. kill ${p.pid}) to release the official session lock.`,
    }));

    return {
      inconsistentThreads,
      officialProcesses,
      summary: {
        totalInconsistent: inconsistentThreads.length,
        officialOccupied: officialProcesses.length,
        externalRecoverable: inconsistentThreads.filter((t) => t.recoverable).length,
      },
    };
  }

  async forceArchive(threadId: string): Promise<ArchiveForceResult> {
    const trimmedId = threadId.trim();
    if (!trimmedId) {
      throw new ArchiveHealthError(-32602, "Invalid thread ID");
    }

    const record = await this.options.repository.find(trimmedId).catch(() => null);
    if (!record) {
      throw new ArchiveHealthError(-32602, `Thread '${trimmedId}' was not found in MappingStore`);
    }

    // Safely update archived flag in MappingStore (pure metadata update, no data deletion)
    await this.options.repository.setArchived(record.hostThreadId, true);

    // Detach from runtime memory if loaded
    this.options.runtime.remove(record.hostThreadId);

    // Broadcast thread/archived event so Desktop UI synchronizes
    await this.options.notifyArchived(record.hostThreadId);

    return {
      ok: true,
      threadId: record.hostThreadId,
      archived: true,
    };
  }
}
