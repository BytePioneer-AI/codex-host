import type { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Writable } from "node:stream";

import type { OfficialAppServerExit } from "../official-app-server-connection.js";
import { NativeProcessRelay, type ProcessExitReceipt } from "../native-process-relay.js";
import type { NativePrivateFiles } from "../native-private-files.js";
import {
  createRemoteOfficialAppServerListener,
  loopbackEndpointFromStderrLine,
} from "../remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "../remote-official-connection.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";

interface LaunchOptions {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}
interface SupervisedLaunch extends LaunchOptions {
  cwd: string;
  supervision: {
    launcher: string;
    files: Pick<NativePrivateFiles, "read">;
    receipt: ProcessExitReceipt;
  };
}

/** Resource ownership exists synchronously; child creation happens only in launch(). */
function processOwner(input: SupervisedLaunch) {
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let relay: NativeProcessRelay | undefined;
  let stopped = false;
  let started = false;
  return {
    get processId() {
      return relay?.processId;
    },
    closed: closed.promise,
    launch() {
      if (started || stopped) throw new Error("Official backend already started or stopped");
      started = true;
      relay = new NativeProcessRelay({
        ...input.supervision,
        program: input.stockCodexPath,
        arguments: input.arguments,
        cwd: input.cwd,
        environment: input.environment,
      });
      void relay.closed.then(closed.resolve);
      return relay;
    },
    async stop() {
      stopped = true;
      if (!relay) {
        closed.resolve({ code: 0, signal: null });
        return;
      }
      await relay.stop();
    },
  };
}

/** Local stdio: exactly one native client and a supervised process tree. */
export function createOwnedStdioBackend(input: SupervisedLaunch): OwnedOfficialBackend {
  const process = processOwner(input);
  let relay: NativeProcessRelay | undefined;
  let claimed = false;
  let stopped = false;
  return {
    get processId() {
      return process.processId;
    },
    closed: process.closed,
    async start() {
      relay = process.launch();
      await relay.start();
    },
    async connect() {
      if (!relay || claimed || stopped)
        throw new Error("Stdio backend requires exactly one native client");
      claimed = true;
      return {
        ...(relay.processId === undefined ? {} : { processId: relay.processId }),
        stdin: relay.stdin,
        stdout: relay.stdout,
        stderr: relay.stderr,
        closed: relay.closed,
        stopProcess: () => {
          if (!relay) throw new Error("Missing official process");
          return relay.stop();
        },
        close: () => relay?.closeInput(),
      };
    },
    async stop() {
      stopped = true;
      await process.stop();
    },
  };
}

function listenerReady(relay: NativeProcessRelay, diagnosticOutput: Writable): Promise<string> {
  relay.stdout.resume();
  relay.stderr.pipe(diagnosticOutput, { end: false });
  return new Promise((resolve, reject) => {
    let pending = "";
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("Official listener readiness timed out")),
      10_000,
    );
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      relay.stderr.off("data", data);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const data = (chunk: Buffer) => {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const endpoint = loopbackEndpointFromStderrLine(
          pending.slice(0, newline).replace(/\r$/, ""),
        );
        if (endpoint) {
          finish(endpoint);
          return;
        }
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 65_536) finish(new Error("Official listener readiness is invalid"));
    };
    relay.stderr.on("data", data);
    void relay.closed.then(() => finish(new Error("Official listener closed before readiness")));
  });
}

/** One private listener with independent native client roles, not per-account listeners. */
export function createOwnedLoopbackBackend(
  input: SupervisedLaunch & { diagnosticOutput: Writable },
): OwnedOfficialBackend {
  const capabilityToken = randomBytes(32).toString("base64url");
  const process = processOwner({
    ...input,
    arguments: [
      ...input.arguments,
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(capabilityToken).digest("hex"),
    ],
  });
  let endpoint: string | undefined;
  return {
    get processId() {
      return process.processId;
    },
    closed: process.closed,
    async start() {
      const relay = process.launch();
      const result = await Promise.all([
        relay.start(),
        listenerReady(relay, input.diagnosticOutput),
      ]);
      endpoint = result[1];
    },
    async connect() {
      if (!endpoint) throw new Error("Official listener is not ready");
      return createRemoteOfficialAppServerConnection(endpoint, { capabilityToken });
    },
    async stop() {
      endpoint = undefined;
      await process.stop();
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
