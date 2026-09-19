import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function runtimeLogPath(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "logs", "host-runtime.log");
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
    mkdirSync(path.dirname(filePath), { recursive: true });
    size = statSync(filePath).size;
  } catch {
    // A missing file starts empty; an unusable directory fails on append below.
  }

  const append = (text: string): void => {
    try {
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(filePath, `${filePath}.1`);
        size = 0;
      }
      appendFileSync(filePath, text);
      size += bytes;
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
