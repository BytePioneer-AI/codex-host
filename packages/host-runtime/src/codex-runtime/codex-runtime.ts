import type { Writable } from "node:stream";

import {
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  type JsonObject,
  type JsonValue,
} from "@codexhost/protocol-core";

import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../official-app-server-connection.js";
import { OfficialRequestBroker } from "../official-request-broker.js";

export type CodexRuntimeOutput = (input: {
  generation: number;
  frame: Buffer<ArrayBufferLike>;
  value: JsonValue;
}) => Promise<void>;

/** One replaceable official protocol connection. Authentication is not its owner. */
export class CodexRuntime {
  readonly generation: number;
  readonly connection: OfficialAppServerConnection;
  readonly broker: OfficialRequestBroker;
  readonly outputTask: Promise<void>;
  #closing = false;
  #closeRequested = false;

  constructor(input: {
    generation: number;
    connection: OfficialAppServerConnection;
    onOutput: CodexRuntimeOutput;
    diagnosticOutput: Writable;
    onClosed(error?: Error): void;
  }) {
    this.generation = input.generation;
    this.connection = input.connection;
    this.connection.stderr.pipe(input.diagnosticOutput, { end: false });
    this.broker = new OfficialRequestBroker({
      send: (request) => writeJsonFrame(this.connection.stdin, request),
    });
    const consuming = this.#consume(input.onOutput);
    this.outputTask = consuming.catch(() => undefined);
    const outputClosed = new Promise<Error>((resolve) => {
      const closed = (): void =>
        resolve(new Error(`Official runtime generation ${this.generation} output closed`));
      this.connection.stdout.once("end", closed);
      this.connection.stdout.once("close", closed);
      this.connection.stdout.once("error", (error) => resolve(error));
    });
    const processClosed = this.connection.closed.then((result) => {
      const status = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `code ${String(result.code ?? "unknown")}`;
      return new Error(`Official runtime generation ${this.generation} exited (${status})`);
    });
    const outputFailed = consuming.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    void Promise.race([outputClosed, processClosed, outputFailed]).then((error) => {
      input.onClosed(this.#closing ? undefined : error);
    });
  }

  sendFrame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Official runtime is closing"));
    return writeFrame(this.connection.stdin, frame);
  }

  send(value: JsonValue): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Official runtime is closing"));
    return writeJsonFrame(this.connection.stdin, value);
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#closing) return Promise.reject(new Error("Official runtime is closing"));
    return this.broker.request(method, params);
  }

  /** Shared sockets must be stopped by their listener owner, not by this client. */
  async stopProcess(): Promise<OfficialAppServerExit> {
    if (!this.connection.stopProcess) {
      throw new Error("Official process shutdown requires the owning listener");
    }
    this.#beginClose();
    const exit = await this.connection.stopProcess();
    this.connection.stdout.destroy();
    return exit;
  }

  /** Retire protocol work before the process owner starts its graceful shutdown. */
  retire(): void {
    this.#beginClose();
  }

  close(): void {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    this.#beginClose();
    this.connection.close();
    this.connection.stdout.destroy();
  }

  #beginClose(): void {
    this.#closing = true;
    this.broker.failAll(new Error("Official runtime is closing"));
  }

  async #consume(onOutput: CodexRuntimeOutput): Promise<void> {
    try {
      const frames = readLfFrames(this.connection.stdout)[Symbol.asyncIterator]();
      let current = await frames.next();
      while (!current.done) {
        const frame = current.value;
        const following = frames.next();
        const value = parseJsonFrame(frame);
        if (!this.broker.handle(value) && !this.#closing) {
          await onOutput({ generation: this.generation, frame, value });
        }
        current = await following;
      }
    } finally {
      this.broker.failAll(
        new Error(`Official runtime generation ${this.generation} output closed`),
      );
    }
  }
}
