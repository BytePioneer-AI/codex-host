import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20;
const RUNTIME_LOG_FILE = /^host-runtime-(\d+)\.log(\.1)?$/u;

interface RuntimeLogFile {
  filePath: string;
  pid: number;
  rotated: boolean;
  size: number;
  modifiedAt: number;
}

function processIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // Permission and platform-specific failures do not prove that the process exited.
    return true;
  }
}

/**
 * Bounds files owned by this logger without touching other diagnostics in the
 * shared logs directory. Active processes keep their current file; their
 * rotated file and inactive process files remain eligible for oldest-first
 * cleanup.
 */
function pruneRuntimeLogs(input: {
  directory: string;
  maxBytes: number;
  maxFiles: number;
  currentPid: number;
  isProcessActive: (pid: number) => boolean;
}): void {
  try {
    const files: RuntimeLogFile[] = [];
    for (const entry of readdirSync(input.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = RUNTIME_LOG_FILE.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid)) continue;
      try {
        const filePath = path.join(input.directory, entry.name);
        const stats = statSync(filePath);
        files.push({
          filePath,
          pid,
          rotated: match[2] === ".1",
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        });
      } catch {
        // A concurrent Runtime may rotate a file while the directory is scanned.
      }
    }

    let total = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.length;
    if (total <= input.maxBytes && count <= input.maxFiles) return;
    const active = new Map<number, boolean>();
    const isActive = (pid: number): boolean => {
      if (pid === input.currentPid) return true;
      const known = active.get(pid);
      if (known !== undefined) return known;
      const value = input.isProcessActive(pid);
      active.set(pid, value);
      return value;
    };
    const candidates = files
      .filter((file) => file.rotated || !isActive(file.pid))
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of candidates) {
      if (total <= input.maxBytes && count <= input.maxFiles) break;
      try {
        rmSync(file.filePath, { force: true });
        total -= file.size;
        count -= 1;
      } catch {
        // Cleanup is best effort and must not affect the Runtime.
      }
    }
  } catch {
    // Cleanup is best effort and must not affect the Runtime.
  }
}

export function runtimeLogPath(environment: NodeJS.ProcessEnv, pid: number): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "logs", `host-runtime-${pid}.log`);
}

/**
 * Keeps the Host Runtime's own stderr diagnostics and fatal stacks in a bounded
 * file. Desktop owns the Runtime's stderr and retains only its last line, so
 * without this a crash leaves no evidence.
 *
 * The monitor event records a fatal error without changing how the process
 * then exits. Logging failures are ignored: they must never affect the Runtime.
 */
export function installRuntimeLog(input: {
  filePath: string;
  stream: { write: NodeJS.WriteStream["write"] };
  process: Pick<NodeJS.Process, "pid" | "on" | "off">;
  maxBytes?: number;
  maxDirectoryBytes?: number;
  maxFiles?: number;
  isProcessActive?: (pid: number) => boolean;
}): () => void {
  const { filePath, stream } = input;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDirectoryBytes = input.maxDirectoryBytes ?? DEFAULT_MAX_DIRECTORY_BYTES;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const logDirectory = path.dirname(filePath);
  const prune = (): void =>
    pruneRuntimeLogs({
      directory: logDirectory,
      // Reserve room for this process's current file before it grows.
      maxBytes: Math.max(0, maxDirectoryBytes - maxBytes),
      maxFiles,
      currentPid: input.process.pid,
      isProcessActive: input.isProcessActive ?? processIsActive,
    });
  let descriptor: number | undefined;
  let size = 0;
  let atLineStart = true;
  const open = (): void => {
    descriptor = openSync(filePath, "a", 0o600);
    chmodSync(filePath, 0o600);
    size = fstatSync(descriptor).size;
  };
  const close = (): void => {
    if (descriptor === undefined) return;
    try {
      closeSync(descriptor);
    } catch {
      // Closing diagnostics must not affect the Runtime.
    }
    descriptor = undefined;
  };
  try {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    chmodSync(logDirectory, 0o700);
    open();
    try {
      chmodSync(`${filePath}.1`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    prune();
  } catch {
    close();
    // Do not capture diagnostics if the private log cannot be prepared.
    return () => {};
  }

  const append = (text: string): void => {
    try {
      let bytes = Buffer.from(text);
      if (bytes.length > maxBytes) {
        let start = bytes.length - maxBytes;
        // Keep the newest diagnostics without cutting through a UTF-8 character.
        while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80) start += 1;
        bytes = bytes.subarray(start);
      }
      if (descriptor === undefined) open();
      if (size > 0 && size + bytes.length > maxBytes) {
        close();
        // Windows does not replace an existing destination with renameSync.
        rmSync(`${filePath}.1`, { force: true });
        renameSync(filePath, `${filePath}.1`);
        open();
        prune();
      }
      if (descriptor === undefined) return;
      writeFileSync(descriptor, bytes);
      size += bytes.length;
    } catch {
      // Ignored by design.
    }
  };
  const stamped = (chunk: string): string => {
    let output = "";
    for (const part of chunk.split(/(?<=\n)/u)) {
      if (!part) continue;
      if (atLineStart) output += `${new Date().toISOString()} [${input.process.pid}] `;
      output += part;
      atLineStart = part.endsWith("\n");
    }
    return output;
  };
  const line = (text: string): void => {
    append(stamped(`${atLineStart ? "" : "\n"}${text}\n`));
  };

  const originalWrite = stream.write;
  stream.write = function write(this: unknown, ...arguments_: unknown[]): boolean {
    const chunk = arguments_[0];
    append(
      stamped(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString()),
    );
    return Reflect.apply(originalWrite, this, arguments_) as boolean;
  } as NodeJS.WriteStream["write"];

  const onFatal = (error: unknown, origin: string): void =>
    line(
      `FATAL ${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  const onExit = (code: number): void => {
    line(`Host Runtime exited with code ${code}`);
    close();
  };
  input.process.on("uncaughtExceptionMonitor", onFatal);
  input.process.on("exit", onExit);
  line("Host Runtime started");

  return () => {
    stream.write = originalWrite;
    input.process.off("uncaughtExceptionMonitor", onFatal);
    input.process.off("exit", onExit);
    close();
  };
}
