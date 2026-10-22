/**
 * Host-side DSH backend for the CodexHost Web right Sidebar.
 *
 * The Web server owns the HTTP listener, authentication, and the WebSocket mux.
 * This module mounts the DSH services those routes forward to: the Typert
 * registry, the local filesystem, DSH Connection, the Typert gateway, the
 * workspace file service, Office conversion, the subprocess provider, and the
 * terminal controller. Only the seams DSH lacks here are supplied: a local
 * Thread's working directory, the sandbox policy's workspace root, and the four
 * Agent fields the terminal controller reads.
 */
import { Context } from "@deepseek-ai/cordis";
import TypertGateway from "@deepseek-ai/dsh-api-gateway";
import WorkspaceFiles from "@deepseek-ai/dsh-api-workspace-files";
import { TYPERT as WorkspaceFilesTypert } from "@deepseek-ai/dsh-api-workspace-files/typert";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection/src/rpc-host.ts";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import OfficeToPdf from "@deepseek-ai/dsh-office-to-pdf";
import { TYPERT as OfficeToPdfTypert } from "@deepseek-ai/dsh-office-to-pdf/typert";
import TerminalController from "@deepseek-ai/dsh-api-terminal-controller";
import { TYPERT as TerminalTypert } from "@deepseek-ai/dsh-api-terminal-controller/typert";
import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import type { GatewayService } from "./gateway-service.ts";

/** Minimal host facts the DSH services consume. */
export interface DshWebBackendOptions {
  /** Absolute fallback root the DSH sandbox policy reports. */
  readonly workspaceRoot: string;
  /**
   * Resolve one local Thread's working directory.
   * @param sessionId - DSH Session identity received from the browser.
   * @returns the Host-recorded directory, or undefined when this Thread has none.
   */
  readonly threadWorkspace: (sessionId: string) => string | undefined;
}

/** One Remote failure in the DSH wire vocabulary. */
export interface DshRemoteFailure {
  readonly code: string;
  readonly message: string;
  readonly details: object;
}

/** The embedded DSH backend. */
export interface DshWebBackend {
  /**
   * Whether this backend owns a Remote endpoint.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @returns true when the DSH gateway mounted the namespace.
   */
  handles(endpoint: string): boolean;
  /**
   * Dispatch one unary Remote request through DSH Connection and the gateway.
   * @param request - Fetch request carrying the Connection `client-request` envelope.
   * @returns the DSH response, including binary attachment responses.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Open one DSH Remote stream.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param args - named wire arguments.
   * @param signal - stream cancellation.
   * @returns the stream's decoded values.
   */
  openStream(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
  /**
   * Convert one stream failure into the DSH wire vocabulary.
   * @param error - failure raised while opening or consuming a stream.
   * @returns the carrier-safe failure.
   */
  failure(error: unknown): DshRemoteFailure;
  /** Dispose the DSH context and every service it mounted. */
  close(): Promise<void>;
}

/** Remote namespaces this context mounts; every other `/api` route stays with Web. */
const NAMESPACES: readonly string[] = ["workspaceFiles", "officeToPdf", "terminal"];

/** A fresh uplink nobody sends on: these DSH methods read no Client items. */
function emptyUplink(): AsyncIterable<unknown> {
  return (async function* () {})();
}

/** The subprocess methods the terminal controller reads through its Agent. */
interface SubprocessPort {
  terminalEnvironment(signal?: AbortSignal): Promise<unknown>;
  resolveExecutable(path: string, environment: undefined, signal: AbortSignal): Promise<unknown>;
  spawnTerminal(spec: unknown): Promise<unknown>;
}

/** One Session header as the DSH file lookup reads it. */
function sessionHeader(sessionId: string, cwd: string): { id: string; header: { cwd: string } } {
  return { id: sessionId, header: { cwd } };
}

/** The four Agent fields the terminal controller reads. */
interface SessionAgent {
  readonly id: string;
  readonly session: { readonly id: string; readonly header: { readonly cwd: string } };
  readonly ctx: Context;
}

/**
 * Mount the DSH backend for the right Sidebar.
 * @param options - local Thread lookup and fallback workspace root.
 * @returns the embedded backend.
 */
export async function createDshWebBackend(options: DshWebBackendOptions): Promise<DshWebBackend> {
  const ctx = new Context();
  const agentLifetimes = new Map<string, Context>();
  try {
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(LocalFileSystem, { cwd: options.workspaceRoot });
    // DSH resolves a Session header from its own session service. Web already
    // owns Thread identity, so this seam answers from the Host-recorded local
    // working directory and returns nothing for every other Thread.
    ctx.provide("sessions", {
      get(sessionId: string): { id: string; header: { cwd: string } } | undefined {
        const cwd = options.threadWorkspace(sessionId);
        return cwd === undefined ? undefined : sessionHeader(sessionId, cwd);
      },
    });
    // The sandbox-policy seam reads only this root when no Session cwd applies.
    const sandboxPolicy: Pick<SandboxPolicyService, "workspaceRoot"> = {
      workspaceRoot: options.workspaceRoot,
    };
    ctx.provide("sandboxPolicy", sandboxPolicy);
    // Web authenticates every request before forwarding it, so Connection is
    // mounted for its shared Fetch handler and Peer, not for its own auth.
    await ctx.plugin((scope: Context) => {
      new HostConnectionService(scope, [], {});
    });
    await ctx.plugin(TypertGateway);
    await ctx.plugin(WorkspaceFiles);
    // Office conversion reads the mounted workspace files and local filesystem.
    await ctx.plugin(OfficeToPdf);
    await ctx.plugin(LocalSubprocess);
    const subprocess = ctx.get("subprocess") as SubprocessPort | undefined;
    if (subprocess === undefined) throw new Error("dsh-web-backend: subprocess is unavailable");
    // Terminal methods take a DSH Agent, but use only its identity, session
    // directory, execution providers, and lifetime. One small adapter per local
    // Thread supplies exactly those; no Agent runtime is mounted.
    const agentFor = (sessionId: string): SessionAgent | undefined => {
      const cwd = options.threadWorkspace(sessionId);
      if (cwd === undefined) return undefined;
      let lifetime = agentLifetimes.get(sessionId);
      if (lifetime === undefined) {
        lifetime = new Context();
        const port: SubprocessPort = {
          terminalEnvironment: (signal) => subprocess.terminalEnvironment(signal),
          resolveExecutable: (path, environment, signal) =>
            subprocess.resolveExecutable(path, environment, signal),
          spawnTerminal: (spec) => subprocess.spawnTerminal(spec),
        };
        lifetime.provide("subprocess", port);
        lifetime.provide("sandboxPolicy", sandboxPolicy);
        agentLifetimes.set(sessionId, lifetime);
      }
      return { id: sessionId, session: { id: sessionId, header: { cwd } }, ctx: lifetime };
    };
    ctx.typert.lookups.register("agent", {
      parameter: "agent",
      wire: "agentId",
      hostTypeSymbol: "@deepseek-ai/dsh-agent#Agent",
      wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
      resolve: agentFor,
    });
    await ctx.plugin(TerminalController);
    // Register the generated Host descriptors so the gateway never derives wire
    // field names from bundled JavaScript parameter names.
    ctx.typert.register(WorkspaceFilesTypert);
    ctx.typert.register(OfficeToPdfTypert);
    ctx.typert.register(TerminalTypert);
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined);
    throw error;
  }
  const connection = ctx.get("connection") as HostConnectionService | undefined;
  const gateway = ctx.get("typertGateway") as GatewayService | undefined;
  if (connection === undefined || gateway === undefined) {
    await ctx.fiber.dispose();
    throw new Error("dsh-web-backend: the gateway mounted without a Connection service");
  }
  const handler = connection.createSharedFetchHandler("/api");
  return {
    handles: (endpoint: string): boolean =>
      NAMESPACES.some((name) => endpoint.startsWith(`${name}/`)),
    fetch: (request: Request): Promise<Response> => handler.fetch(request),
    openStream: (
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>> =>
      gateway.wireStream.open(endpoint, { args }, emptyUplink(), undefined, signal),
    failure: (error: unknown): DshRemoteFailure => gateway.wireStream.failure(error),
    close: async (): Promise<void> => {
      await ctx.fiber.dispose().catch(() => undefined);
      for (const lifetime of agentLifetimes.values()) await lifetime.fiber.dispose();
    },
  };
}
