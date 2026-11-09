/** DSH's route and index service embedded behind the codexhost HTTP carrier. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Service, type Context } from "@deepseek-ai/cordis";
import { renderIndexInjections, type IndexInjection } from "./injections.ts";
export { renderIndexInjections } from "./injections.ts";
export type { IndexInjection, IndexInjectionPlacement } from "./injections.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
  interface Events {
    "webserver/index-inject"(table: IndexInjection[]): void;
  }
}

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
export interface WebUpgradeRoute {
  path: string;
  handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>;
}
export interface Config {
  /** The existing carrier owns binding and authentication. */
  address(): { host: string; port: number };
  reserved?: readonly Pick<WebRoute, "kind" | "path">[];
}

function contains(route: Pick<WebRoute, "kind" | "path">, path: string): boolean {
  return (
    route.path === path ||
    (route.kind === "prefix" && (route.path === "/" || path.startsWith(`${route.path}/`)))
  );
}

/** Original DSH registration semantics; no listener or second authentication layer. */
export class WebServer extends Service {
  private readonly exact = new Map<string, WebRoute>();
  private readonly prefixes = new Map<string, WebRoute>();
  private readonly upgrades = new Map<string, WebUpgradeRoute>();
  private readonly sockets = new Set<Duplex>();
  private readonly indexTaps: ((html: string) => string)[] = [];
  private fallback: WebRoute["handler"] | undefined;

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, "webServer");
    ctx.effect(() => () => {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  get host(): string {
    return this.config.address().host;
  }
  get port(): number {
    return this.config.address().port;
  }

  private check(route: Pick<WebRoute, "kind" | "path">): void {
    if (!route.path.startsWith("/") || route.path.includes("?") || route.path.includes("#"))
      throw new Error(`webserver: invalid route "${route.path}"`);
    if (
      this.config.reserved?.some(
        (reserved) =>
          contains(reserved, route.path) ||
          (route.kind === "prefix" && contains(route, reserved.path)),
      )
    )
      throw new Error(`webserver: reserved route "${route.path}"`);
  }

  register(route: WebRoute): () => void {
    this.check(route);
    const table = route.kind === "exact" ? this.exact : this.prefixes;
    if (table.has(route.path))
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    table.set(route.path, route);
    return () => {
      if (table.get(route.path) === route) table.delete(route.path);
    };
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    this.check({ kind: "exact", path: route.path });
    if (this.upgrades.has(route.path))
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
    this.upgrades.set(route.path, route);
    return () => {
      if (this.upgrades.get(route.path) === route) this.upgrades.delete(route.path);
    };
  }

  registerFallback(handler: WebRoute["handler"]): () => void {
    if (this.fallback !== undefined) throw new Error("webserver: fallback already registered");
    this.fallback = handler;
    return () => {
      if (this.fallback === handler) this.fallback = undefined;
    };
  }

  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform);
    return () => {
      const at = this.indexTaps.indexOf(transform);
      if (at !== -1) this.indexTaps.splice(at, 1);
    };
  }

  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname);
    if (exact !== undefined) return exact;
    let best: WebRoute | undefined;
    for (const route of this.prefixes.values()) {
      if (!contains(route, pathname)) continue;
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
    return best;
  }

  /** The carrier calls this after authentication and its own named routes. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (this.config.reserved?.some((route) => contains(route, pathname))) return false;
    const handler = this.match(pathname)?.handler ?? this.fallback;
    if (handler === undefined) return false;
    await handler(req, res);
    return true;
  }

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const route = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);
    if (route === undefined) return false;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    await route.handler(req, socket, head);
    return true;
  }

  applyIndexTaps(html: string): string {
    for (const transform of this.indexTaps) html = transform(html);
    return html;
  }

  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = [];
    this.ctx.emit("webserver/index-inject", table);
    return table;
  }

  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()));
  }
}
export default WebServer;
