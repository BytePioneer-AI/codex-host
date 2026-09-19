import type { JsonObject } from "@codexhost/shared-contracts";
import type { RpcMessage, TransportOptions } from "./transport.js";

/** A Session connection, not ownership of the Desktop or its process tree. */
export interface ZcodeConnection {
  readonly options: TransportOptions;
  readonly locator?: JsonObject;
  onMessage: ((message: RpcMessage) => void) | undefined;
  onFault: ((error: Error) => void) | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void | Promise<void>;
  reject(id: string | number, message?: string): void;
  close(): Promise<void>;
}
