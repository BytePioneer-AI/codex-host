import type { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";

import { officialLoopbackListenerArguments } from "../remote-app-server.js";
import {
  createLoopbackOfficialAppServerListener,
  createRemoteOfficialAppServerListener,
} from "../remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "../remote-official-connection.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";

interface LaunchOptions {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

/** One private listener with independent native clients, not per-account listeners. */
export function createOwnedLoopbackBackend(input: {
  cwd?: string;
  stockCodexPath: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
  spawnOfficial?: typeof spawn;
}): OwnedOfficialBackend {
  const capabilityToken = randomBytes(32).toString("base64url");
  const listener = createLoopbackOfficialAppServerListener({
    ...input,
    arguments: [
      ...officialLoopbackListenerArguments(input.arguments),
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(capabilityToken).digest("hex"),
    ],
    // Managed stderr may carry credential-bearing errors. Never forward raw bytes.
    diagnosticOutput: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  let endpoint: string | undefined;
  return {
    get processId() {
      return listener.processId;
    },
    closed: listener.closed,
    async start() {
      endpoint = await listener.listen();
    },
    async connect() {
      if (!endpoint) throw new Error("Official listener is not ready");
      return createRemoteOfficialAppServerConnection(endpoint, { capabilityToken });
    },
    async stop() {
      endpoint = undefined;
      await listener.close();
    },
  };
}

/** Unix transport is distinct from deployment policy; account management remains
 * gated on its separately verified native process/storage capabilities. */
export function createOwnedUnixBackend(
  input: LaunchOptions & {
    diagnosticOutput: Writable;
    socketPath: string;
    spawnOfficial?: typeof spawn;
    closeTimeoutMs?: number;
  },
): OwnedOfficialBackend {
  const listener = createRemoteOfficialAppServerListener(input);
  let ready = false;
  return {
    get processId() {
      return listener.processId;
    },
    closed: listener.closed,
    async start() {
      await listener.listen();
      ready = true;
    },
    async connect() {
      if (!ready) throw new Error("Official listener is not ready");
      return createRemoteOfficialAppServerConnection(input.socketPath);
    },
    async stop() {
      ready = false;
      await listener.close();
    },
  };
}
