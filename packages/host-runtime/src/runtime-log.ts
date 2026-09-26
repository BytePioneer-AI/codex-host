import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function runtimeLogPath(environment: NodeJS.ProcessEnv, pid: number): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "logs", `host-runtime-${pid}.log`);
}

/**
 * Keeps the Host Runtime's own stderr diagnostics and fatal stacks in a bounded
 * file. Desktop owns the Runtime's stderr and retains only its last line, so
 * without this a crash leaves no evidence. Conversation content, protocol
 * traffic and credentials are never written here.
 *
 * The monitor event records a fatal error without changing how the process
 * then exits. Logging failures are ignored: they must never affect the Runtime.
 */
export function installRuntimeLog(input: {
  filePath: string;
  stream: { write: NodeJS.WriteStream["write"] };
  process: Pick<NodeJS.Process, "pid" | "on" | "off">;
  maxBytes?: number;
}): () => void {
  const { filePath, stream } = input;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  let size = 0;
  let atLineStart = true;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(filePath), 0o700);
    appendFileSync(filePath, "", { mode: 0o600 });
    chmodSync(filePath, 0o600);
    try {
      chmodSync(`${filePath}.1`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    size = statSync(filePath).size;
  } catch {
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
      if (size > 0 && size + bytes.length > maxBytes) {
        renameSync(filePath, `${filePath}.1`);
        size = 0;
      }
      appendFileSync(filePath, bytes, { mode: 0o600 });
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
  const onExit = (code: number): void => line(`Host Runtime exited with code ${code}`);
  input.process.on("uncaughtExceptionMonitor", onFatal);
  input.process.on("exit", onExit);
  line("Host Runtime started");

  return () => {
    stream.write = originalWrite;
    input.process.off("uncaughtExceptionMonitor", onFatal);
    input.process.off("exit", onExit);
  };
}
