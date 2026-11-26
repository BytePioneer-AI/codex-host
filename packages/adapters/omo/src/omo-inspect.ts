import { spawn } from "node:child_process";

import type { CommandInvocation } from "@codexhost/harness-discovery";

import { normalizeOmoModelCatalog, type OmoModelCatalog } from "./omo-model-catalog.js";
import { assertCompatible, parseOmoProtocolInfo, type OmoProtocolInfo } from "./omo-protocol.js";
import {
  OmoRpcSession,
  omoRpcProcessCommand,
  type OmoRpcProcessAdapter,
  type OmoRpcProcessCommandDependencies,
  type OmoRpcProcessOptions,
} from "./omo-rpc-session.js";

/**
 * Short-lived `omo --mode rpc --no-session` handshake used only by `inspect`.
 *
 * The handshake never creates a Native Session and never submits content:
 * `--no-session` keeps the engine from writing a session file, and
 * `PI_OFFLINE=1` keeps a Model list read from doing network work. It reuses the
 * RPC transport for framing, command correlation, bounded command budgets, and
 * process-tree shutdown; only the Session's `get_state`/`set_client_info`
 * startup exchange is shared with a real Session.
 */

export interface OmoInspectSessionOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** Native facts a ready inspection is built from. */
export interface OmoInspection {
  readonly protocol: OmoProtocolInfo;
  readonly catalog: OmoModelCatalog;
}

export interface OmoInspectSession {
  /** Runs the whole handshake. Rejects with the transport's typed errors. */
  inspect(): Promise<OmoInspection>;
  /** Idempotent; ends the handshake process. */
  close(): Promise<void>;
}

/**
 * Builds the inspect launch invocation. Unlike a Session launch it carries
 * `--no-session`, which is the only wire-level difference from the transport's
 * own command builder.
 */
export function omoInspectProcessCommand(
  options: OmoRpcProcessOptions,
  dependencies: Partial<OmoRpcProcessCommandDependencies> = {},
): CommandInvocation {
  const invocation = omoRpcProcessCommand(options, dependencies);
  return { ...invocation, arguments: [...invocation.arguments, "--no-session"] };
}

const noSessionProcessAdapter: OmoRpcProcessAdapter = {
  spawn(options) {
    const invocation = omoInspectProcessCommand(options);
    return spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      // A POSIX process group is what makes the tree kill reach grandchildren.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  },
};

export function createOmoInspectSession(
  options: OmoInspectSessionOptions,
  processAdapter?: OmoRpcProcessAdapter,
): OmoInspectSession {
  const rpcOptions = {
    cwd: options.cwd,
    ...(options.command === undefined ? {} : { command: options.command }),
    environment: { ...options.environment, PI_OFFLINE: "1" },
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
  };
  const rpc = new OmoRpcSession(rpcOptions, processAdapter ?? noSessionProcessAdapter);
  let closePromise: Promise<void> | null = null;
  return {
    async inspect(): Promise<OmoInspection> {
      await rpc.start();
      const protocol = parseOmoProtocolInfo((await rpc.send("get_protocol_info")).data);
      assertCompatible(protocol);
      const catalog = normalizeOmoModelCatalog((await rpc.send("get_available_models")).data);
      return { protocol, catalog };
    },
    close(): Promise<void> {
      closePromise ??= rpc.close();
      return closePromise;
    },
  };
}
