import path from "node:path";
import { discoverHostClientChannel } from "@codexhost/desktop-control";
import {
  parseJsonFrame,
  readLfFrames,
  writeJsonFrame,
  type JsonValue,
} from "@codexhost/protocol-core";
import {
  OfficialRuntimeClient,
  type OfficialRuntimeScope,
} from "./codex-runtime/official-runtime-scope.js";
import {
  RetiredOfficialServerRequestError,
  type OwnedOfficialBackend,
} from "./codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "./official-app-server-connection.js";
import {
  createRemoteOfficialAppServerConnection,
  PrivateOfficialHandshakeError,
} from "./remote-official-connection.js";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import { object, rpcId } from "./shared-thread-peer.js";

/** Each SSH connection is an ordinary native client of the independent Host. */
export function nativeRelaySession(
  scope: OfficialRuntimeScope,
  streams: RemoteAppServerSessionStreams,
): RemoteAppServerSession {
  let client: OfficialRuntimeClient | undefined;
  let detached = false;
  const disconnected = Promise.withResolvers<undefined>();
  const detach = () => {
    if (detached) return;
    detached = true;
    void client?.close();
    streams.input.destroy();
    disconnected.resolve(undefined);
  };
  const write = async (value: JsonValue) => {
    if (detached) return;
    if (streams.output.destroyed) {
      detach();
      return;
    }
    try {
      await writeJsonFrame(streams.output, value);
    } catch {
      detach();
    }
  };
  const forward = async () => {
    for await (const frame of readLfFrames(streams.input, {
      maxFrameBytes: 128 * 1024 * 1024,
    })) {
      if (detached) break;
      const value = parseJsonFrame(frame);
      if (!object(value)) throw new Error("Invalid native frame");
      if (!client) {
        if (value.method !== "initialize" || !rpcId(value.id) || !object(value.params))
          throw new Error("Native initialization required");
        client = new OfficialRuntimeClient({
          scope,
          output: ({ value }) => write(value),
          onBackendStopped: detach,
        });
        await client.initialize();
        if (detached) break;
        const reply = await client.initializeProtocol(value.params);
        await write({ ...reply, id: value.id });
      } else {
        try {
          await client.send(value);
        } catch (error) {
          if (detached) break;
          if (error instanceof RetiredOfficialServerRequestError) {
            streams.diagnosticOutput.write("codexhost: discarded a retired native server reply\n");
          } else if (typeof value.method === "string" && rpcId(value.id)) {
            await write({
              id: value.id,
              error: { code: -32001, message: "Official request failed; retry explicitly" },
            });
          } else {
            throw error;
          }
        }
      }
    }
  };
  return {
    disconnect: detach,
    close: detach,
    async run() {
      try {
        await Promise.race([forward(), disconnected.promise]);
        return 0;
      } catch (error) {
        if (detached) return 0;
        throw error;
      } finally {
        detach();
      }
    },
  };
}

/** Stopping the SSH listener releases only its connections to this Host generation. */
export function sharedNativeBackend(dataDirectory: string): OwnedOfficialBackend {
  const ended = Promise.withResolvers<OfficialAppServerExit>();
  let descriptor: Awaited<ReturnType<typeof discoverHostClientChannel>>;
  let monitor: OfficialAppServerConnection | undefined;
  const connect = async () => {
    if (!descriptor || descriptor.owner !== "service")
      throw new Error("Independent native Host unavailable");
    return createRemoteOfficialAppServerConnection(`ws://127.0.0.1:${descriptor.port}/v1/native`, {
      capabilityToken: descriptor.token,
      handshakeTimeoutMs: 5_000,
    });
  };
  return {
    closed: ended.promise,
    connect,
    async start() {
      try {
        descriptor = await discoverHostClientChannel(path.join(dataDirectory, "client-hosts"));
        monitor = await connect();
      } catch (error) {
        const reason =
          error instanceof PrivateOfficialHandshakeError
            ? error.message
            : "independent Host descriptor unavailable";
        process.stderr.write(`codexhost: shared native backend start: ${reason}\n`);
        throw error;
      }
      monitor.stderr.resume();
      void monitor.closed.then(ended.resolve);
    },
    async stop() {
      descriptor = null;
      monitor?.close();
      if (monitor) await monitor.closed;
      ended.resolve({ code: 0, signal: null });
    },
  };
}
