import type { Writable } from "node:stream";

import {
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  type JsonObject,
  type JsonValue,
} from "@codexhost/protocol-core";

import type { CodexAccount } from "../account/account-repository.js";
import type { OfficialAppServerConnection } from "../official-app-server-connection.js";
import { OfficialRequestBroker } from "../official-request-broker.js";

export type CodexRuntimeOutput = (input: {
  accountId: string;
  frame: Buffer<ArrayBufferLike>;
  value: JsonValue;
}) => Promise<void>;

/** One official app-server process/connection, isolated by an Account's CODEX_HOME. */
export class CodexRuntime {
  readonly account: CodexAccount;
  readonly connection: OfficialAppServerConnection;
  readonly broker: OfficialRequestBroker;
  readonly outputTask: Promise<void>;

  constructor(input: {
    account: CodexAccount;
    connection: OfficialAppServerConnection;
    onOutput: CodexRuntimeOutput;
    diagnosticOutput: Writable;
    onClosed(error?: Error): void;
  }) {
    this.account = input.account;
    this.connection = input.connection;
    this.connection.stderr.pipe(input.diagnosticOutput, { end: false });
    this.broker = new OfficialRequestBroker({
      send: (request) => writeJsonFrame(this.connection.stdin, request),
    });
    const consuming = this.#consume(input.onOutput);
    this.outputTask = consuming.catch(() => undefined);
    const outputClosed = new Promise<Error>((resolve) => {
      const closed = (): void =>
        resolve(new Error(`Codex Account runtime '${this.account.accountId}' output closed`));
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
      return new Error(`Codex Account runtime '${this.account.accountId}' exited (${status})`);
    });
    const outputFailed = consuming.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    void Promise.race([outputClosed, processClosed, outputFailed]).then(input.onClosed);
  }

  sendFrame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return writeFrame(this.connection.stdin, frame);
  }

  send(value: JsonValue): Promise<void> {
    return writeJsonFrame(this.connection.stdin, value);
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    return this.broker.request(method, params);
  }

  close(): void {
    this.broker.failAll(new Error(`Codex Account runtime '${this.account.accountId}' closed`));
    this.connection.close();
    this.connection.stdout.destroy();
  }

  async #consume(onOutput: CodexRuntimeOutput): Promise<void> {
    try {
      const frames = readLfFrames(this.connection.stdout)[Symbol.asyncIterator]();
      let current = await frames.next();
      while (!current.done) {
        const frame = current.value;
        const following = frames.next();
        const value = parseJsonFrame(frame);
        if (!this.broker.handle(value)) {
          await onOutput({ accountId: this.account.accountId, frame, value });
        }
        current = await following;
      }
    } finally {
      this.broker.failAll(
        new Error(`Codex Account runtime '${this.account.accountId}' output closed`),
      );
    }
  }
}
