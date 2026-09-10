import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";
import type { OfficialAppServerExit } from "./official-app-server-connection.js";

const MAX_CONTENT = 262_144;
const MAX_RESPONSE = MAX_CONTENT * 4 + 16_384;
const contentSchema = z
  .object({ content: z.array(z.number().int().min(0).max(255)).max(MAX_CONTENT).nullable() })
  .strict();
const successSchema = z.object({ ok: z.literal(true) }).strict();
const readySchema = z.object({ ready: z.literal(true) }).strict();

export class NativePrivateFileError extends Error {
  constructor(readonly code: "unavailable" | "failed" | "writer-stop-unconfirmed") {
    super(`Native private storage ${code}`);
    this.name = "NativePrivateFileError";
  }
}

export function privateFileDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface NativePrivateFileLease {
  readonly closed: Promise<OfficialAppServerExit>;
  release(): Promise<void>;
}

/** Secrets use bounded stdin/stdout only. Native stderr and errors are never forwarded. */
export class NativePrivateFiles {
  readonly #launcher: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #allowReadOnlyAccess: boolean;
  #writer: OfficialProcessLifecycle | undefined;

  constructor(input: {
    launcher: string;
    environment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowReadOnlyAccess?: boolean;
  }) {
    if (!path.isAbsolute(input.launcher)) throw new NativePrivateFileError("unavailable");
    this.#launcher = input.launcher;
    this.#timeoutMs = input.timeoutMs ?? 30_000;
    this.#allowReadOnlyAccess = input.allowReadOnlyAccess ?? false;
    const allowed = new Set([
      "SYSTEMROOT",
      "WINDIR",
      "PATH",
      "TMP",
      "TEMP",
      "HOME",
      "USERPROFILE",
      "LANG",
    ]);
    this.#environment = Object.fromEntries(
      Object.entries(input.environment ?? process.env).filter(([name]) =>
        allowed.has(name.toUpperCase()),
      ),
    );
  }

  async ensureDirectory(directory: string): Promise<void> {
    this.#success(await this.#run({ operation: "ensure-directory", directory }));
  }

  async read(directory: string, name: string): Promise<Buffer | null> {
    const response = await this.#run({ operation: "read", directory, name });
    const parsed = contentSchema.safeParse(response);
    if (!parsed.success) throw new NativePrivateFileError("failed");
    return parsed.data.content === null ? null : Buffer.from(parsed.data.content);
  }

  async replace(
    directory: string,
    name: string,
    content: Uint8Array,
    expected: string | null,
  ): Promise<void> {
    if (content.byteLength > MAX_CONTENT) throw new NativePrivateFileError("failed");
    this.#success(
      await this.#run({ operation: "replace", directory, name, content: [...content], expected }),
    );
  }

  async remove(directory: string, name: string, expected: string): Promise<void> {
    this.#success(await this.#run({ operation: "remove", directory, name, expected }));
  }

  async lock(directory: string, name: string): Promise<NativePrivateFileLease> {
    const command = this.#spawn({ operation: "lock", directory, name }, true);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        command.response,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new NativePrivateFileError("failed")), this.#timeoutMs);
        }),
      ]);
      if (!readySchema.safeParse(response).success) throw new NativePrivateFileError("failed");
      return {
        closed: command.lifecycle.closed,
        release: async () => {
          await command.lifecycle.stop();
        },
      };
    } catch {
      await this.#stop(command.lifecycle);
      throw new NativePrivateFileError("failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  #success(response: unknown): void {
    if (!successSchema.safeParse(response).success) throw new NativePrivateFileError("failed");
  }

  async #run(request: Record<string, unknown>): Promise<unknown> {
    if (this.#writer) throw new NativePrivateFileError("writer-stop-unconfirmed");
    const command = this.#spawn(request, false);
    this.#writer = command.lifecycle;
    void command.lifecycle.closed.then(() => {
      if (this.#writer === command.lifecycle) this.#writer = undefined;
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const [response, exit] = await Promise.race([
        Promise.all([command.response, command.lifecycle.closed]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new NativePrivateFileError("failed")), this.#timeoutMs);
        }),
      ]);
      if (exit.error || exit.code !== 0 || exit.signal) throw new NativePrivateFileError("failed");
      return response;
    } catch {
      // A timed-out helper may still be writing. Never permit rollback before exit.
      await this.#stop(command.lifecycle);
      throw new NativePrivateFileError("failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async #stop(lifecycle: OfficialProcessLifecycle): Promise<void> {
    try {
      await lifecycle.stop();
    } catch {
      throw new NativePrivateFileError("writer-stop-unconfirmed");
    }
  }

  #spawn(
    request: Record<string, unknown>,
    keepOpen: boolean,
  ): {
    lifecycle: OfficialProcessLifecycle;
    response: Promise<unknown>;
  } {
    let payload: string;
    try {
      payload = `${JSON.stringify({
        ...request,
        allow_read_only_directory: this.#allowReadOnlyAccess,
      })}\n`;
      if (Buffer.byteLength(payload) > MAX_RESPONSE) throw new Error("oversized");
    } catch {
      throw new NativePrivateFileError("failed");
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#launcher, ["private-file"], {
        env: this.#environment,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      throw new NativePrivateFileError("unavailable");
    }
    // The same owned-child exit primitive is used here, not a second process protocol.
    const lifecycle = new OfficialProcessLifecycle(child, { endInput: () => child.stdin.end() });
    child.stderr.resume();
    const response = new Promise<unknown>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(new NativePrivateFileError("failed"));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (bytes.byteLength + chunk.byteLength > MAX_RESPONSE) {
          fail();
          return;
        }
        bytes = Buffer.concat([bytes, chunk]);
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        try {
          const value: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
          if (
            bytes
              .subarray(newline + 1)
              .toString("utf8")
              .trim() !== ""
          ) {
            fail();
            return;
          }
          settled = true;
          resolve(value);
        } catch {
          fail();
        } finally {
          bytes = Buffer.alloc(0);
        }
      });
      child.stdout.once("error", fail);
      child.stdout.once("end", fail);
      child.stdin.once("error", fail);
      void lifecycle.closed.then((exit) => {
        if (exit.error) fail();
      });
    });
    if (keepOpen) child.stdin.write(payload);
    else child.stdin.end(payload);
    return { lifecycle, response };
  }
}
