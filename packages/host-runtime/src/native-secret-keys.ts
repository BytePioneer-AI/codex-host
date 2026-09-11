import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { z } from "zod";

import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";

const SECRET_BYTES = 32;
const REQUEST_LIMIT = 256;
const RESPONSE_LIMIT = 1_024;
const MAX_QUEUED_OPERATIONS = 64;
const keyIdPattern = /^[0-9a-f]{64}$/;
const responseSchema = z
  .object({
    content: z.array(z.number().int().min(0).max(255)).length(SECRET_BYTES).nullable(),
  })
  .strict();

export class NativeSecretKeyError extends Error {
  constructor(readonly code: "unavailable" | "failed") {
    super(`Native secret storage ${code}`);
    this.name = "NativeSecretKeyError";
  }
}

/** OS-backed binary keys over bounded stdin/stdout; stderr is always discarded. */
export class NativeSecretKeys {
  readonly #launcher: string;
  readonly #environment: NodeJS.ProcessEnv;
  #queue: Promise<void> = Promise.resolve();
  #queuedOperations = 0;
  #blocked = false;

  constructor(input: { launcher: string; environment?: NodeJS.ProcessEnv }) {
    if (!path.isAbsolute(input.launcher)) throw new NativeSecretKeyError("unavailable");
    this.#launcher = input.launcher;
    const allowed = new Set([
      "SYSTEMROOT",
      "WINDIR",
      "PATH",
      "TMP",
      "TEMP",
      "HOME",
      "USERPROFILE",
      "LANG",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
    ]);
    this.#environment = Object.fromEntries(
      Object.entries(input.environment ?? process.env).filter(([name]) =>
        allowed.has(name.toUpperCase()),
      ),
    );
  }

  async read(keyId: string): Promise<Buffer | null> {
    return this.#operate("read", keyId);
  }

  async create(keyId: string): Promise<Buffer> {
    const created = await this.#operate("create", keyId);
    if (!created) throw new NativeSecretKeyError("failed");
    return created;
  }

  async #operate(operation: "read" | "create", keyId: string): Promise<Buffer | null> {
    if (!keyIdPattern.test(keyId)) throw new NativeSecretKeyError("failed");
    if (this.#blocked) throw new NativeSecretKeyError("failed");
    if (this.#queuedOperations >= MAX_QUEUED_OPERATIONS) {
      throw new NativeSecretKeyError("failed");
    }
    this.#queuedOperations += 1;
    const predecessor = this.#queue;
    const next = Promise.withResolvers<undefined>();
    this.#queue = next.promise;
    await predecessor;
    try {
      if (this.#blocked) throw new NativeSecretKeyError("failed");
      return await this.#run(operation, keyId);
    } finally {
      this.#queuedOperations -= 1;
      next.resolve(undefined);
    }
  }

  async #run(operation: "read" | "create", keyId: string): Promise<Buffer | null> {
    const payload = `${JSON.stringify({ operation, key_id: keyId })}\n`;
    if (Buffer.byteLength(payload) > REQUEST_LIMIT) throw new NativeSecretKeyError("failed");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#launcher, ["secret-key"], {
        env: this.#environment,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      throw new NativeSecretKeyError("unavailable");
    }
    const lifecycle = new OfficialProcessLifecycle(child, { endInput: () => child.stdin.end() });
    child.stderr.resume();
    const response = this.#response(child, lifecycle);
    child.stdin.end(payload);

    let timeout: NodeJS.Timeout | undefined;
    try {
      const [value, exit] = await Promise.race([
        Promise.all([response, lifecycle.closed]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new NativeSecretKeyError("failed")), 30_000);
        }),
      ]);
      if (exit.error || exit.code !== 0 || exit.signal) throw new NativeSecretKeyError("failed");
      return value;
    } catch {
      try {
        await lifecycle.stop();
      } catch {
        this.#blocked = true;
      }
      throw new NativeSecretKeyError("failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  #response(
    child: ChildProcessWithoutNullStreams,
    lifecycle: OfficialProcessLifecycle,
  ): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(new NativeSecretKeyError("failed"));
      };
      const parse = (): void => {
        if (settled) return;
        const bytes = Buffer.concat(chunks, byteLength);
        const newline = bytes.indexOf(10);
        if (newline < 0) {
          fail();
          return;
        }
        try {
          if (
            bytes
              .subarray(newline + 1)
              .toString("utf8")
              .trim() !== ""
          ) {
            fail();
            return;
          }
          const parsed = responseSchema.safeParse(
            JSON.parse(bytes.subarray(0, newline).toString("utf8")),
          );
          if (!parsed.success) {
            fail();
            return;
          }
          settled = true;
          resolve(parsed.data.content === null ? null : Buffer.from(parsed.data.content));
        } catch {
          fail();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > RESPONSE_LIMIT) {
          fail();
          return;
        }
        chunks.push(chunk);
      });
      child.stdout.once("error", fail);
      child.stdout.once("end", parse);
      child.stdin.once("error", fail);
      void lifecycle.closed.then((exit) => {
        if (exit.error) fail();
      });
    });
  }
}
