import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { parseJsonFrame, readLfFrames, type JsonObject } from "@codexhost/protocol-core";

import type { NativePrivateFiles } from "./native-private-files.js";
import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";
import type { OfficialAppServerExit } from "./official-app-server-connection.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const failure = (): Error =>
  new Error("Native process relay is unavailable or its tree exit is unconfirmed");

export interface ProcessExitReceipt {
  directory: string;
  name: string;
  tag: string;
}

/** Generic native process channels. Child bytes cannot forge lifecycle frames. */
export class NativeProcessRelay {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
  readonly closed: Promise<OfficialAppServerExit>;
  readonly processId: number | undefined;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lifecycle: OfficialProcessLifecycle;
  readonly #receipt: ProcessExitReceipt;
  readonly #files: Pick<NativePrivateFiles, "read">;
  readonly #ready = Promise.withResolvers<number>();
  #nativePid: number | undefined;
  #stopped = false;
  #nativeExitCode: number | null | undefined;
  #invalid = false;
  #verifiedExit: OfficialAppServerExit | undefined;
  #stopping: Promise<OfficialAppServerExit> | undefined;

  constructor(input: {
    launcher: string;
    program: string;
    arguments: string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    receipt: ProcessExitReceipt;
    files: Pick<NativePrivateFiles, "read">;
  }) {
    if (![input.launcher, input.program, input.cwd, input.receipt.directory].every(path.isAbsolute))
      throw failure();
    const request = Buffer.from(
      JSON.stringify({
        program: input.program,
        arguments: input.arguments,
        cwd: input.cwd,
        receipt_directory: input.receipt.directory,
        receipt_name: input.receipt.name,
        tag: input.receipt.tag,
      }) + "\n",
    );
    if (request.length > 128 * 1024) throw failure();
    this.#receipt = { ...input.receipt };
    this.#files = input.files;
    this.#child = spawn(input.launcher, ["supervise-process"], {
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.processId = this.#child.pid;
    this.stdin = this.#child.stdin;
    this.#lifecycle = new OfficialProcessLifecycle(this.#child, {
      timeoutMs: 10_000,
      endInput: () => this.stdin.end(),
    });
    this.#child.stderr.resume();
    this.stdin.on("error", () => this.#ready.reject(failure()));
    void this.#ready.promise.catch(() => undefined);
    const output = this.#consume().catch(() => {
      this.#invalid = true;
      this.#ready.reject(failure());
      this.stdin.end();
    });
    this.closed = this.#lifecycle.closed.then(async (exit) => {
      await output;
      this.#ready.reject(failure());
      this.stdout.end();
      this.stderr.end();
      const result = {
        ...exit,
        code: this.#nativeExitCode === undefined ? exit.code : this.#nativeExitCode,
      };
      return this.#invalid || !this.#stopped ? { ...result, error: failure() } : result;
    });
    this.stdin.write(request);
  }

  async start(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failure()), 5000);
        }),
      ]);
    } catch {
      this.stdin.end();
      throw failure();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop(): Promise<OfficialAppServerExit> {
    if (this.#verifiedExit) return Promise.resolve(this.#verifiedExit);
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stop();
    this.#stopping = stopping;
    void stopping.then(
      () => {
        this.#stopping = undefined;
      },
      () => {
        this.#stopping = undefined;
      },
    );
    return stopping;
  }

  async #stop(): Promise<OfficialAppServerExit> {
    await this.#lifecycle.stop();
    // Output belongs to the retired connection. A paused consumer must not keep
    // process ownership alive after the native helper has actually exited.
    this.stdout.destroy();
    this.stderr.destroy();
    const exit = await this.closed;
    // Node confirms a failed native-helper spawn without ever assigning a PID.
    if (this.processId === undefined) {
      this.#verifiedExit = exit;
      return exit;
    }
    const bytes = await this.#files.read(this.#receipt.directory, this.#receipt.name).catch(() => {
      throw failure();
    });
    if (!bytes) throw failure();
    let value: unknown;
    try {
      value = parseJsonFrame(bytes);
    } catch {
      throw failure();
    }
    if (
      !object(value) ||
      value.version !== 1 ||
      value.tag !== this.#receipt.tag ||
      value.treeExited !== true ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid > 0xffff_ffff ||
      (this.#nativePid !== undefined && value.pid !== this.#nativePid)
    )
      throw failure();
    this.#verifiedExit = exit;
    return exit;
  }

  closeInput(): void {
    this.stdin.end();
  }

  async #consume(): Promise<void> {
    for await (const frame of readLfFrames(this.#child.stdout, { maxFrameBytes: 32 * 1024 })) {
      const value = parseJsonFrame(frame);
      if (!object(value) || this.#stopped) throw failure();
      if (value.event === "started") {
        if (
          this.#nativePid !== undefined ||
          value.version !== 1 ||
          typeof value.pid !== "number" ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 0 ||
          value.pid > 0xffff_ffff
        )
          throw failure();
        this.#nativePid = value.pid;
        this.#ready.resolve(value.pid);
      } else if (value.event === "output") {
        if (
          this.#nativePid === undefined ||
          (value.channel !== "stdout" && value.channel !== "stderr") ||
          !Array.isArray(value.bytes) ||
          value.bytes.length > 4096 ||
          value.bytes.some(
            (byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255,
          )
        )
          throw failure();
        const target = value.channel === "stdout" ? this.stdout : this.stderr;
        if (!target.destroyed) {
          const bytes = Buffer.from(value.bytes as number[]);
          await new Promise<void>((resolve, reject) =>
            target.write(bytes, (error) =>
              error && !target.destroyed ? reject(failure()) : resolve(),
            ),
          );
        }
      } else if (value.event === "stopped") {
        if (
          this.#nativePid === undefined ||
          !(
            value.code === null ||
            (typeof value.code === "number" && Number.isSafeInteger(value.code))
          )
        )
          throw failure();
        this.#nativeExitCode = value.code;
        this.#stopped = true;
      } else throw failure();
    }
  }
}
