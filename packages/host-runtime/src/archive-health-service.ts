import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ArchiveHealthInconsistentThread,
  ArchiveHealthParams,
  ArchiveHealthProcess,
  ArchiveHealthResult,
  ArchiveForceResult,
} from "@codexhost/shared-contracts";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

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
  canRelease?(thread: ExternalThread): boolean;
  diagnose?(error: unknown): void;
  listOfficialProcesses?(): Promise<Array<{ pid: number; command: string }>>;
}

export function parseCommandExecutable(command: string): string {
  const trimmed = command.trim();
  const match = /^("[^"]+"|[^\s]+)/.exec(trimmed);
  if (!match) return "";
  let exec = match[1] ?? "";
  if (exec.startsWith('"') && exec.endsWith('"')) {
    exec = exec.slice(1, -1);
  }
  return path.basename(exec).toLowerCase();
}

export function isCodexProcess(command: string, ppid?: number): boolean {
  const lower = command.toLowerCase();

  // Exclude codexhost itself, shims, and wrappers
  if (lower.includes("codexhost") || lower.includes("codex-host")) {
    return false;
  }

  // Exclude Electron GUI, helper, renderer, and crashpad processes
  if (
    lower.includes("codex (renderer)") ||
    lower.includes("codex (service)") ||
    lower.includes("codex (gpu)") ||
    lower.includes("codex helper") ||
    lower.includes("codex framework") ||
    lower.includes("browser_crashpad_handler") ||
    lower.includes("skycomputeruseservice")
  ) {
    return false;
  }

  // Exclude our own child process tree
  if (ppid !== undefined && ppid === process.pid) {
    return false;
  }

  // Direct executable token
  const exec = parseCommandExecutable(command);
  if (exec === "codex" || exec === "codex-cli" || exec === "codex.exe") {
    return true;
  }

  // Node script
  if (exec === "node" || exec === "node.exe" || exec === "bun" || exec === "bun.exe") {
    const parts = command.trim().split(/\s+/);
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]?.toLowerCase() ?? "";
      if (part.endsWith("/codex") || part.endsWith("codex.js") || part.endsWith("codex-cli.js")) {
        return true;
      }
    }
  }

  return false;
}

export async function defaultListCodexProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  try {
    const isWindows = process.platform === "win32";
    if (isWindows) {
      // Use powershell to query Win32_Process safely with proper quoting
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ]);
      const parsed: unknown = JSON.parse(stdout);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const results: Array<{ pid: number; command: string }> = [];
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          const pid = Number((item as { ProcessId?: unknown }).ProcessId);
          const ppid = Number((item as { ParentProcessId?: unknown }).ParentProcessId);
          const command = String((item as { CommandLine?: unknown }).CommandLine ?? "");
          if (
            Number.isInteger(pid) &&
            pid !== process.pid &&
            isCodexProcess(command, Number.isInteger(ppid) ? ppid : undefined)
          ) {
            results.push({ pid, command });
          }
        }
      }
      return results;
    }

    const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,command"]);
    const lines = stdout.split("\n");
    const results: Array<{ pid: number; command: string }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("PID")) continue;
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed);
      if (!match) continue;
      const pid = Number.parseInt(match[1] ?? "", 10);
      const ppid = Number.parseInt(match[2] ?? "", 10);
      const command = match[3] ?? "";
      if (
        Number.isInteger(pid) &&
        pid !== process.pid &&
        isCodexProcess(command, Number.isInteger(ppid) ? ppid : undefined)
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

  async inspect(params?: ArchiveHealthParams): Promise<ArchiveHealthResult> {
    const inconsistentThreads: ArchiveHealthInconsistentThread[] = [];

    // 1. Inspect external threads from repository and runtime
    const repositoryThreads = await this.options.repository.list();
    const inMemoryThreads = this.options.runtime.values();

    // Check all repository records (skip records already archived)
    for (const record of repositoryThreads) {
      if (record.archived) continue;

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
          hint: "Session release failed. Run safe force-archive to mark archived in MappingStore and release resources.",
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
      } else if (record.state !== "ready" && !thread?.running) {
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: record.state,
          reason: "Uncommitted or abandoned provisional thread record",
          recoverable: true,
          hint: "Uncommitted draft record. Safe to force-archive.",
        });
      }
    }

    // Check in-memory threads with no persistent repository record (orphaned runtime instances)
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

    // 2. Inspect official Codex processes (unless includeOfficial === false)
    const officialProcesses: ArchiveHealthProcess[] = [];
    if (params?.includeOfficial !== false) {
      const listProcesses = this.options.listOfficialProcesses ?? defaultListCodexProcesses;
      const rawProcesses = await listProcesses();
      const killCmd = process.platform === "win32" ? "taskkill /PID " : "kill ";
      for (const p of rawProcesses) {
        officialProcesses.push({
          pid: p.pid,
          command: p.command,
          hint: `Process PID ${p.pid} is running: '${p.command}'. Terminate it (e.g. ${killCmd}${p.pid}) to release the official session lock.`,
        });
      }
    }

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
    const inMemory = this.options.runtime.get(trimmedId);

    if (!record && !inMemory) {
      throw new ArchiveHealthError(-32602, `Thread '${trimmedId}' was not found`);
    }

    // 1. Guard against busy running threads
    if (inMemory) {
      if (inMemory.running || inMemory.activeTurnId !== null) {
        throw new ArchiveHealthError(
          -32072,
          `External Thread '${trimmedId}' is currently running an active turn. Cancel or wait for the turn to settle before force-archiving.`,
        );
      }
      if (this.options.canRelease && !this.options.canRelease(inMemory)) {
        throw new ArchiveHealthError(
          -32072,
          `External Thread '${trimmedId}' has active background work or pending interactions and cannot be force-archived.`,
        );
      }

      // Safely close and drain the loaded session to prevent duplicate writers
      try {
        await inMemory.session.close();
        await inMemory.outputTask;
      } catch (error) {
        this.options.diagnose?.(error);
      }
      this.options.runtime.remove(inMemory.id);
    }

    // 2. Safely mark archived=true in MappingStore if record exists (pure metadata update)
    if (record) {
      await this.options.repository.setArchived(record.hostThreadId, true);
    }

    // 3. Broadcast notification
    await this.options.notifyArchived(trimmedId);

    return {
      ok: true,
      threadId: trimmedId,
      archived: true,
    };
  }
}
