/** DSH's embedded route and index service. */
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
export default class WebServer {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
  renderIndex(html: string): string;
}
export function renderIndexInjections(html: string, rows: readonly unknown[]): string;
