import path from "node:path";
import { MobileModelProtocol } from "./mobile-model-protocol.js";
import { MobileModelPreferences } from "./mobile-model-preferences.js";
import { AppServerHost, type AppServerHostOptions } from "./app-server-host.js";
import { createFrontendInitializationGate } from "./frontend-initialization-gate.js";
import { SharedThreadBridge } from "./shared-thread-bridge.js";
import { SharedThreadOwner } from "./shared-thread-owner.js";
import { createProductionExternalThreadStore } from "./external-thread-repository.js";
import {
  createRemoteAppServerWebSocketListener,
  prepareRemoteAppServerSocketDirectory,
  type RemoteAppServerSessionStreams,
} from "./remote-app-server.js";
import type { DelegationControlRegistration } from "./delegation-types.js";

export const REMOTE_HOST_SOCKET_ENV = "CODEXHOST_REMOTE_HOST_SOCKET";

/** Opt-in until the matching official Remote-Control forwarding build is installed. */
export function localSharedHostSocket(environment: NodeJS.ProcessEnv): string | undefined {
  const socketPath = environment[REMOTE_HOST_SOCKET_ENV];
  if (socketPath === undefined) return undefined;
  if (process.platform === "win32" || !path.isAbsolute(socketPath)) {
    throw new Error(`${REMOTE_HOST_SOCKET_ENV} requires an absolute Unix socket path`);
  }
  return socketPath;
}

/** One external owner and store, independent frontend handshakes and native clients. */
export async function startLocalSharedHost(input: {
  socketPath: string;
  common: AppServerHostOptions;
  onOwnerDelegation?: AppServerHostOptions["onDelegationApi"];
  onFrontendDelegation?: AppServerHostOptions["onDelegationApi"];
}) {
  const environment = input.common.environment ?? process.env;
  const diagnosticOutput = input.common.diagnosticOutput ?? process.stderr;
  const store = input.common.mappingStore ?? createProductionExternalThreadStore(environment);
  await store.initialize();
  const owner = new SharedThreadOwner();
  let delegation: DelegationControlRegistration | undefined;
  const common = { ...input.common, mappingStore: store, closeMappingStoreOnExit: false };
  const external = new AppServerHost({
    ...common,
    arguments: [],
    externalOnly: true,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    onDelegationApi: (api) => {
      delegation = api;
      return input.onOwnerDelegation?.(api);
    },
  });
  const externalRunning = external.run();
  const frontends = new Set<AppServerHost>();
  const running = new Set<Promise<number>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const mobilePreferences = new MobileModelPreferences(environment);
  function createFrontend(streams: RemoteAppServerSessionStreams, mobile = false) {
    if (closed) throw new Error("Local shared Host is closed");
    const gate = createFrontendInitializationGate(streams, () => host.close());
    const mobilePeer = mobile ? owner.connect() : undefined;
    const host = new AppServerHost({
      ...(mobilePeer
        ? { mobileModels: new MobileModelProtocol(mobilePeer, mobilePreferences) }
        : {}),
      ...common,
      // Frontends may load plugin catalogs, but never share the owner's Adapter instances.
      externalAdapters: new Map(),
      arguments: [],
      ...(delegation ? { sharedDelegation: delegation } : {}),
      desktopInput: gate.input,
      desktopOutput: gate.output,
      diagnosticOutput: streams.diagnosticOutput,
      sharedThreads: new SharedThreadBridge({
        connect: async () => owner.connect(),
        delegateCreates: true,
        mobile,
        diagnose: (error) =>
          streams.diagnosticOutput.write(`codexhost shared Threads: ${String(error)}\n`),
      }),
      ...(input.onFrontendDelegation ? { onDelegationApi: input.onFrontendDelegation } : {}),
    });
    frontends.add(host);
    const frontend = host;
    return {
      host: frontend,
      run() {
        const task = frontend.run().finally(() => {
          frontends.delete(frontend);
          running.delete(task);
          gate.close();
          mobilePeer?.close();
        });
        running.add(task);
        return task;
      },
      disconnect: () => frontend.disconnect(),
      close: () => frontend.close(),
    };
  }
  const listener = createRemoteAppServerWebSocketListener({
    socketPath: input.socketPath,
    diagnosticOutput,
    createSession: (streams) => createFrontend(streams, true),
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const frontend of frontends) frontend.close();
      try {
        await listener.close();
        await Promise.allSettled([...running]);
      } finally {
        external.close();
        owner.close();
        try {
          await externalRunning;
        } finally {
          owner.output.end();
          await store.close();
        }
      }
    })();
    return closing;
  };
  const closeAfterOwnerExit = () => {
    if (!closed)
      void close().catch(() => {
        diagnosticOutput.write("codexhost: local shared Host cleanup failed\n");
      });
  };
  void externalRunning.then(closeAfterOwnerExit, closeAfterOwnerExit);
  try {
    await prepareRemoteAppServerSocketDirectory(input.socketPath);
    await listener.listen();
    if (closed) throw new Error("Local external owner exited during startup");
  } catch (error) {
    await close();
    throw error;
  }
  return { createFrontend, close, closed: listener.closed };
}
