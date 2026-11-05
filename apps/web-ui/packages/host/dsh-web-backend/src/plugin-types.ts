/** Carrier-facing Web plugin contracts; no framework implementation types escape the backend. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ClientAssets, ClientSource } from "./client-assets.ts";

export interface WebPluginPackage {
  readonly id: string;
  readonly directory: string;
}
export interface BundleEntry {
  id: string;
  name: string;
  config?: unknown;
  group?: boolean | null;
  disabled?: boolean | null;
  inject?: string[] | Record<string, unknown> | null;
}
export interface WebPluginRuntimeOptions {
  packages: readonly WebPluginPackage[];
  builtins: readonly ClientSource[];
  address(): { host: string; port: number };
  reserved?: readonly { kind: "exact" | "prefix"; path: string }[];
}
export interface WebPluginResult {
  loadedIds: string[];
  loadErrors: Record<string, string>;
}
export interface WebPluginRuntime {
  readonly clients: ClientAssets;
  /** Called by the carrier's existing serialized management queue. */
  update(packages: readonly WebPluginPackage[], changedId?: string): Promise<WebPluginResult>;
  /** Built-in SSE endpoint; the carrier authenticates before dispatch. */
  events(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
  renderIndex(html: string): string;
  close(): Promise<void>;
}
