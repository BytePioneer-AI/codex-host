import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

export interface CodexHostRuntimeDescriptor {
  schemaVersion: 1;
  protocolVersion: 1;
  pid: number;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: number;
}

export function runtimeDescriptorPath(environment: NodeJS.ProcessEnv = process.env): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "runtime.json");
}

export async function readRuntimeDescriptor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CodexHostRuntimeDescriptor> {
  const value = JSON.parse(await readFile(runtimeDescriptorPath(environment), "utf8")) as unknown;
  if (!isRuntimeDescriptor(value)) {
    throw new Error("Invalid codexhost runtime descriptor");
  }
  return value;
}

function isRuntimeDescriptor(value: unknown): value is CodexHostRuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  return (
    descriptor.schemaVersion === 1 &&
    descriptor.protocolVersion === 1 &&
    descriptor.host === "127.0.0.1" &&
    typeof descriptor.port === "number" &&
    typeof descriptor.token === "string" &&
    typeof descriptor.pid === "number" &&
    typeof descriptor.startedAt === "number"
  );
}


export function externalHarnessTransportModel(harnessId: string): string {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(harnessId) || harnessId === "codex") {
    throw new Error(`Invalid external Harness ID: ${harnessId}`);
  }
  const payload = [...JSON.stringify({ harnessId })]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return `codexhost/plugin-v1@${payload}`;
}

export type JsonRpcId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexHostClient extends EventEmitter {
  readonly descriptor: CodexHostRuntimeDescriptor;
  readonly socket: WebSocket;

  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  private constructor(descriptor: CodexHostRuntimeDescriptor, socket: WebSocket) {
    super();
    this.descriptor = descriptor;
    this.socket = socket;
    socket.on("message", (data) => this.#handleMessage(data.toString()));
    socket.on("close", () => this.#failPending(new Error("codexhost connection closed")));
    socket.on("error", (error) => {
      if (this.listenerCount("error") > 0) this.emit("error", error);
      else this.emit("socketError", error);
    });
  }

  static async connect(environment: NodeJS.ProcessEnv = process.env): Promise<CodexHostClient> {
    const descriptor = await readRuntimeDescriptor(environment);
    const url = `ws://${descriptor.host}:${descriptor.port}/`;
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new CodexHostClient(descriptor, socket);
    try {
      await client.request("initialize", {
        clientInfo: { name: "codexhost_external_ui", version: "1" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(payload, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  close(): void {
    this.socket.close();
  }

  #handleMessage(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.emit("protocolError", new Error("Invalid JSON frame from codexhost"));
      return;
    }
    if (!value || typeof value !== "object") return;

    const message = value as Record<string, unknown>;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);

      if ("error" in message) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.emit("message", value);
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      this.emit("serverRequest", message.id, message.method, message.params);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message.method, message.params);
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
