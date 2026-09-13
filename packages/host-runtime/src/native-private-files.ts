import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import type { OfficialAppServerExit } from "./official-app-server-connection.js";
import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";

const MAX_CONTENT = 20 * 1024 * 1024;
const MAX_FRAME = MAX_CONTENT * 4 + 16_384;
const MAX_QUEUED_OPERATIONS = 64;
const contentSchema = z
  .object({ content: z.array(z.number().int().min(0).max(255)).max(MAX_CONTENT).nullable() })
  .strict();
const successSchema = z.object({ ok: z.literal(true) }).strict();
const readySchema = z.object({ ready: z.literal(true) }).strict();
const failedSchema = z.object({ error: z.literal("failed") }).strict();

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

type Request = Record<string, unknown>;

interface Session {
  child: ChildProcessWithoutNullStreams;
  lifecycle: OfficialProcessLifecycle;
  responses: BoundedResponses;
}

class BoundedResponses {
  #bytes = Buffer.alloc(0);
  #values: unknown[] = [];
  #waiter: ReturnType<typeof Promise.withResolvers<unknown>> | undefined;
  #failure: NativePrivateFileError | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.#accept(chunk));
    child.stdout.once("error", () => this.#fail());
    child.stdout.once("end", () => this.#fail());
    child.stdin.once("error", () => this.#fail());
  }

  next(): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.#waiter) return Promise.reject(new NativePrivateFileError("failed"));
    this.#waiter = Promise.withResolvers<unknown>();
    return this.#waiter.promise;
  }

  #accept(chunk: Buffer): void {
    if (this.#failure) return;
    if (this.#bytes.byteLength + chunk.byteLength > MAX_FRAME) return this.#fail();
    this.#bytes = Buffer.concat([this.#bytes, chunk]);
    let newline = this.#bytes.indexOf(10);
    while (newline >= 0) {
      const line = this.#bytes.subarray(0, newline);
      this.#bytes = this.#bytes.subarray(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        return this.#fail();
      }
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter.resolve(value);
      } else if (this.#values.length === 0) {
        this.#values.push(value);
      } else {
        return this.#fail();
      }
      newline = this.#bytes.indexOf(10);
    }
  }

  #fail(): void {
    if (this.#failure) return;
    this.#failure = new NativePrivateFileError("failed");
    this.#bytes = Buffer.alloc(0);
    this.#values = [];
    this.#waiter?.reject(this.#failure);
    this.#waiter = undefined;
  }
}

class NativePrivateFileDriver {
  readonly #launcher: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedOperations = 0;
  #lockRequested = false;
  #releaseRequested = false;
  #releasing = false;
  #terminal: NativePrivateFileError["code"] | undefined;
  #session: Session | undefined;

  constructor(input: { launcher: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number }) {
    if (!path.isAbsolute(input.launcher)) throw new NativePrivateFileError("unavailable");
    this.#launcher = input.launcher;
    this.#timeoutMs = input.timeoutMs ?? 30_000;
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

  operate(request: Request): Promise<unknown> {
    return this.#enqueue(async () => {
      this.#available();
      return this.#session
        ? this.#persistentOperation(this.#session, request)
        : this.#oneShot(request);
    });
  }

  lock(request: Request): Promise<NativePrivateFileLease> {
    if (this.#terminal) return Promise.reject(new NativePrivateFileError(this.#terminal));
    if (this.#lockRequested || this.#releaseRequested) {
      return Promise.reject(new NativePrivateFileError("failed"));
    }
    if (this.#queuedOperations >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new NativePrivateFileError("failed"));
    }
    this.#lockRequested = true;
    return this.#enqueue(async () => {
      this.#available();
      let session: Session | undefined;
      try {
        const payload = this.#payload(request);
        session = this.#spawn();
        const response = session.responses.next();
        await this.#write(session.child, payload, false);
        const ready = await this.#withinTimeout(response);
        if (!readySchema.safeParse(ready).success) throw new NativePrivateFileError("failed");
        this.#session = session;
        const activeSession = session;
        void session.lifecycle.closed.then(() => {
          if (this.#session === activeSession && !this.#releasing) this.#terminal = "unavailable";
        });
        let released: Promise<void> | undefined;
        return {
          closed: session.lifecycle.closed,
          release: () => {
            if (released) return released;
            this.#releaseRequested = true;
            released = this.#enqueue(() => this.#release(activeSession), true);
            return released;
          },
        };
      } catch (error) {
        if (session && this.#session !== session) await this.#retireFailedSession(session);
        if (!this.#session && !this.#terminal) this.#lockRequested = false;
        throw error;
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>, bypassLimit = false): Promise<T> {
    if (this.#releaseRequested && !bypassLimit) {
      return Promise.reject(new NativePrivateFileError(this.#terminal ?? "unavailable"));
    }
    if (!bypassLimit && this.#queuedOperations >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new NativePrivateFileError("failed"));
    }
    this.#queuedOperations += 1;
    const predecessor = this.#tail;
    const next = Promise.withResolvers<undefined>();
    this.#tail = next.promise;
    return (async () => {
      await predecessor;
      try {
        return await operation();
      } finally {
        this.#queuedOperations -= 1;
        next.resolve(undefined);
      }
    })();
  }

  async #oneShot(request: Request): Promise<unknown> {
    const payload = this.#payload(request);
    const session = this.#spawn();
    const response = session.responses.next();
    try {
      await this.#write(session.child, payload, true);
      const [value, exit] = await this.#withinTimeout(
        Promise.all([response, session.lifecycle.closed]),
      );
      if (exit.error || exit.code !== 0 || exit.signal) throw new NativePrivateFileError("failed");
      return value;
    } catch {
      await this.#retireFailedSession(session);
      throw new NativePrivateFileError("failed");
    }
  }

  async #persistentOperation(session: Session, request: Request): Promise<unknown> {
    const payload = this.#payload(request);
    const response = session.responses.next();
    let value: unknown;
    try {
      await this.#write(session.child, payload, false);
      value = await this.#withinTimeout(response);
      const schema = request.operation === "read" ? contentSchema : successSchema;
      if (!schema.safeParse(value).success && !failedSchema.safeParse(value).success) {
        throw new NativePrivateFileError("failed");
      }
    } catch {
      await this.#retireFailedSession(session);
      throw new NativePrivateFileError("failed");
    }
    if (failedSchema.safeParse(value).success) throw new NativePrivateFileError("failed");
    return value;
  }

  async #release(session: Session): Promise<void> {
    this.#releasing = true;
    let exit: OfficialAppServerExit;
    try {
      exit = await session.lifecycle.stop();
    } catch {
      this.#terminal = "writer-stop-unconfirmed";
      throw new NativePrivateFileError("writer-stop-unconfirmed");
    } finally {
      this.#releasing = false;
    }
    this.#terminal = "unavailable";
    this.#session = undefined;
    if (exit.error || exit.code !== 0 || exit.signal) throw new NativePrivateFileError("failed");
  }

  async #retireFailedSession(session: Session): Promise<void> {
    try {
      await session.lifecycle.stop();
      if (this.#session === session) this.#terminal = "unavailable";
    } catch {
      this.#terminal = "writer-stop-unconfirmed";
      throw new NativePrivateFileError("writer-stop-unconfirmed");
    }
  }

  #spawn(): Session {
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
    child.stderr.resume();
    return {
      child,
      lifecycle: new OfficialProcessLifecycle(child, {
        timeoutMs: this.#timeoutMs,
        endInput: () => child.stdin.end(),
      }),
      responses: new BoundedResponses(child),
    };
  }

  #payload(request: Request): string {
    let payload: string;
    try {
      payload = `${JSON.stringify(request)}\n`;
    } catch {
      throw new NativePrivateFileError("failed");
    }
    if (Buffer.byteLength(payload) > MAX_FRAME) throw new NativePrivateFileError("failed");
    return payload;
  }

  #write(child: ChildProcessWithoutNullStreams, payload: string, end: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (error?: Error | null): void =>
        error ? reject(new NativePrivateFileError("failed")) : resolve();
      try {
        if (end) child.stdin.end(payload, done);
        else child.stdin.write(payload, done);
      } catch {
        reject(new NativePrivateFileError("failed"));
      }
    });
  }

  #withinTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NativePrivateFileError("failed")), this.#timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  #available(): void {
    if (this.#terminal) throw new NativePrivateFileError(this.#terminal);
  }
}

const sharedDriver = Symbol("NativePrivateFiles.sharedDriver");

/** Bounded native file access. A writer lease owns all later I/O until confirmed release. */
export class NativePrivateFiles {
  readonly #driver: NativePrivateFileDriver;
  readonly #allowReadOnlyDirectoryAccess: boolean;

  constructor(
    input:
      | {
          launcher: string;
          environment?: NodeJS.ProcessEnv;
          timeoutMs?: number;
          allowReadOnlyAccess?: boolean;
        }
      | { [sharedDriver]: NativePrivateFileDriver; allowReadOnlyAccess: boolean },
  ) {
    if (sharedDriver in input) {
      this.#driver = input[sharedDriver];
      this.#allowReadOnlyDirectoryAccess = input.allowReadOnlyAccess;
    } else {
      this.#driver = new NativePrivateFileDriver(input);
      this.#allowReadOnlyDirectoryAccess = input.allowReadOnlyAccess ?? false;
    }
  }

  withReadOnlyDirectoryAccess(): NativePrivateFiles {
    return new NativePrivateFiles({
      [sharedDriver]: this.#driver,
      allowReadOnlyAccess: true,
    });
  }

  async ensureDirectory(directory: string): Promise<void> {
    this.#success(await this.#run({ operation: "ensure-directory", directory }));
  }

  async read(directory: string, name: string): Promise<Buffer | null> {
    const parsed = contentSchema.safeParse(await this.#run({ operation: "read", directory, name }));
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

  lock(directory: string, name: string): Promise<NativePrivateFileLease> {
    return this.#driver.lock(this.#request({ operation: "lock", directory, name }));
  }

  #run(request: Request): Promise<unknown> {
    return this.#driver.operate(this.#request(request));
  }

  #request(request: Request): Request {
    return {
      ...request,
      allow_read_only_directory: this.#allowReadOnlyDirectoryAccess,
    };
  }

  #success(response: unknown): void {
    if (!successSchema.safeParse(response).success) throw new NativePrivateFileError("failed");
  }
}
