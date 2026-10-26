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
const CLOSE_TIMEOUT_MS = 60_000;

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
  listProcesses?(): Promise<Array<{ pid: number; ppid: number; command: string }>>;
  /** Bound for confirming a forced close. Defaults to {@link CLOSE_TIMEOUT_MS}. */
  closeTimeoutMs?: number;
}

/** The executable token, honouring a leading quoted path. */
export function executablePath(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

/** Splits a command tail on whitespace, keeping double-quoted groups together. */
function splitArguments(input: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (current) values.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) values.push(current);
  return values;
}

/** Arguments after the executable, with surrounding quotes removed. */
export function commandArguments(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  let rest: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    rest = end > 0 ? trimmed.slice(end + 1) : "";
  } else {
    const match = /^\S+/.exec(trimmed);
    rest = match ? trimmed.slice(match[0].length) : "";
  }
  return splitArguments(rest);
}

const INTERPRETERS = new Set(["node", "node.exe", "bun", "bun.exe", "deno"]);

/**
 * A live Codex CLI process, as opposed to the Desktop GUI, its helpers, a
 * codexhost-owned backend, or an unrelated process that merely mentions codex.
 */
export function isCodexProcess(command: string): boolean {
  const exec = executablePath(command);
  if (!exec) return false;
  const lowerExec = exec.toLowerCase();
  // Desktop app bundle (main binary, helpers, renderer) and its framework.
  if (lowerExec.includes(".app/")) return false;
  // Host-owned processes and shims.
  if (lowerExec.includes("codexhost") || lowerExec.includes("codex-host")) return false;

  const base = path.basename(lowerExec);
  if (INTERPRETERS.has(base)) {
    const script = commandArguments(command)[0];
    if (!script) return false;
    const lowerScript = script.toLowerCase();
    if (lowerScript.includes("codexhost") || lowerScript.includes("codex-host")) return false;
    const scriptBase = path.basename(lowerScript);
    return (
      scriptBase === "codex" ||
      scriptBase === "codex.js" ||
      scriptBase === "codex.mjs" ||
      scriptBase === "codex-cli" ||
      scriptBase === "codex-cli.js"
    );
  }
  return base === "codex" || base === "codex-cli" || base === "codex.exe";
}

/** PIDs reachable from `rootPid`, excluding the root itself. */
export function descendantsOf(
  processes: ReadonlyArray<{ pid: number; ppid: number }>,
  rootPid: number,
): Set<number> {
  const descendants = new Set<number>();
  let added = true;
  while (added) {
    added = false;
    for (const process_ of processes) {
      if (process_.pid === rootPid || descendants.has(process_.pid)) continue;
      if (process_.ppid === rootPid || descendants.has(process_.ppid)) {
        descendants.add(process_.pid);
        added = true;
      }
    }
  }
  return descendants;
}

export async function defaultListProcesses(): Promise<
  Array<{ pid: number; ppid: number; command: string }>
> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const results: Array<{ pid: number; ppid: number; command: string }> = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const pid = Number((item as { ProcessId?: unknown }).ProcessId);
      const ppid = Number((item as { ParentProcessId?: unknown }).ParentProcessId);
      const command = String((item as { CommandLine?: unknown }).CommandLine ?? "");
      if (Number.isInteger(pid) && Number.isInteger(ppid)) results.push({ pid, ppid, command });
    }
    return results;
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,command"], {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const results: Array<{ pid: number; ppid: number; command: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      results.push({ pid, ppid, command: match[3] ?? "" });
    }
  }
  return results;
}

function terminationHint(pid: number): string {
  return process.platform === "win32" ? `taskkill /PID ${pid}` : `kill ${pid}`;
}

export class ArchiveHealthService {
  constructor(private readonly options: ArchiveHealthServiceOptions) {}

  async inspect(params?: ArchiveHealthParams): Promise<ArchiveHealthResult> {
    const inconsistentThreads: ArchiveHealthInconsistentThread[] = [];
    const repositoryThreads = await this.options.repository.list();
    const inMemoryThreads = this.options.runtime.values();

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
      } else if (record.state !== "ready" && !thread?.unsubmittedPrewarm) {
        // `creating` is the only uncommitted state; a normal prewarm draft is healthy.
        inconsistentThreads.push({
          threadId: record.hostThreadId,
          title: record.title ?? null,
          harnessId: record.harnessId ?? null,
          kind: "external",
          state: record.state,
          reason: "Uncommitted thread record",
          recoverable: true,
          hint: "Uncommitted draft record. Safe to force-archive.",
        });
      }
    }

    for (const thread of inMemoryThreads) {
      if (repositoryThreads.some((record) => record.hostThreadId === thread.id)) continue;
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

    const officialProcesses: ArchiveHealthProcess[] = [];
    if (params?.includeOfficial !== false) {
      const listProcesses = this.options.listProcesses ?? defaultListProcesses;
      const listed = await listProcesses();
      const excluded = descendantsOf(listed, process.pid);
      for (const candidate of listed) {
        if (candidate.pid === process.pid || excluded.has(candidate.pid)) continue;
        if (!isCodexProcess(candidate.command)) continue;
        officialProcesses.push({
          pid: candidate.pid,
          command: candidate.command,
          hint: `Process PID ${candidate.pid} is running: '${candidate.command}'. Terminate it (e.g. ${terminationHint(candidate.pid)}) to release the official session lock.`,
        });
      }
    }

    return {
      inconsistentThreads,
      officialProcesses,
      summary: {
        totalInconsistent: inconsistentThreads.length,
        officialOccupied: officialProcesses.length,
        externalRecoverable: inconsistentThreads.filter((thread) => thread.recoverable).length,
      },
    };
  }

  async forceArchive(threadId: string): Promise<ArchiveForceResult> {
    const trimmedId = threadId.trim();
    if (!trimmedId) throw new ArchiveHealthError(-32602, "Invalid thread ID");

    let record: Awaited<ReturnType<ExternalThreadRepository["find"]>>;
    try {
      record = await this.options.repository.find(trimmedId);
    } catch (error) {
      throw new ArchiveHealthError(
        -32081,
        `External Thread ownership could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const thread = this.options.runtime.get(trimmedId);
    if (!record && !thread) {
      throw new ArchiveHealthError(-32602, `Thread '${trimmedId}' was not found`);
    }

    if (thread) {
      if (thread.running || thread.activeTurnId !== null) {
        throw new ArchiveHealthError(
          -32072,
          `External Thread '${trimmedId}' is running an active turn. Wait for it to settle before force-archiving.`,
        );
      }
      if (this.options.canRelease && !this.options.canRelease(thread)) {
        throw new ArchiveHealthError(
          -32072,
          `External Thread '${trimmedId}' has background work or pending interactions and cannot be force-archived.`,
        );
      }
      // A confirmed close is required before detaching: releasing an instance that
      // still owns the native session would allow a second writer after recovery.
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          (async () => {
            await thread.session.close();
            await thread.outputTask;
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Session release timed out")),
              this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
            );
            timeout.unref();
          }),
        ]);
      } catch (error) {
        this.options.diagnose?.(error);
        throw new ArchiveHealthError(
          -32075,
          `External Session close could not be confirmed for '${trimmedId}'; the Thread stays loaded to avoid duplicate writers.`,
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (this.options.runtime.get(trimmedId) !== thread) {
        throw new ArchiveHealthError(
          -32076,
          `External Thread '${trimmedId}' changed while closing; retry the request.`,
        );
      }
      this.options.runtime.remove(trimmedId);
    }

    if (record) await this.options.repository.setArchived(record.hostThreadId, true);

    // The archive state is already durable; a failed notification must not report
    // the whole operation as failed.
    try {
      await this.options.notifyArchived(trimmedId);
    } catch (error) {
      this.options.diagnose?.(error);
    }

    return { ok: true, threadId: trimmedId, archived: true };
  }
}
