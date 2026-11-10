import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { MappingStore, MappingStoreError } from "@codexhost/mapping-store";

import type { AppServerHost } from "./app-server-host.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import {
  createProductionExternalThreadStore,
  type ExternalThreadStore,
  type MappingStoreOwnerRole,
} from "./external-thread-repository.js";
import {
  createRemoteAppServerWebSocketListener,
  prepareRemoteAppServerSocketDirectory,
} from "./remote-app-server.js";
import {
  SharedThreadBridge,
  connectSharedThreads,
  sharedThreadSocketPath,
} from "./shared-thread-bridge.js";
import { SharedThreadOwner } from "./shared-thread-owner.js";
import type { SharedThreadPeer } from "./shared-thread-peer.js";

export interface SharedExternalThreadRuntimeOptions {
  environment: NodeJS.ProcessEnv;
  ownerRole: MappingStoreOwnerRole;
  diagnosticOutput?: Writable;
  peerConnectTimeoutMs?: number;
  onFatalError?: () => void;
  createExternalStore?: (
    environment: NodeJS.ProcessEnv,
    ownerRole: MappingStoreOwnerRole,
  ) => ExternalThreadStore;
  createExternalHost(options: {
    mappingStore: ExternalThreadStore;
    desktopInput: Readable;
    desktopOutput: Writable;
    onDelegationApi: (api: DelegationControlRegistration) => (() => void) | undefined;
  }): AppServerHost;
  registerCatalogDelegation(api: DelegationControlRegistration): (() => void) | undefined;
}

export interface SharedExternalThreadRuntime {
  readonly mappingStore: ExternalThreadStore;
  readonly sharedDelegation: DelegationControlRegistration | undefined;
  createBridge(diagnosticOutput: Writable): SharedThreadBridge;
  close(): Promise<void>;
}

async function waitForSharedThreadPeer(
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SharedThreadPeer | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const peer = await connectSharedThreads(environment).catch(() => null);
    if (peer) return peer;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createDelegatingExternalThreadStore(
  getStore: () => ExternalThreadStore,
): ExternalThreadStore {
  return new Proxy({} as ExternalThreadStore, {
    get(_target, property) {
      const store = getStore();
      const value: unknown = Reflect.get(store, property, store);
      return typeof value === "function" ? value.bind(store) : value;
    },
  });
}

export async function acquireSharedExternalThreadRuntime(
  options: SharedExternalThreadRuntimeOptions,
): Promise<SharedExternalThreadRuntime> {
  const diagnosticOutput = options.diagnosticOutput ?? process.stderr;
  const peerConnectTimeoutMs = options.peerConnectTimeoutMs ?? 3_000;
  const ownedStore = (options.createExternalStore ?? createProductionExternalThreadStore)(
    options.environment,
    options.ownerRole,
  );

  let activeStore: ExternalThreadStore = ownedStore;
  let ownedInitialized = false;
  let fallbackStore: MappingStore | undefined;
  let fallbackDirectory: string | undefined;
  let sharedOwner: SharedThreadOwner | undefined;
  let sharedDelegation: DelegationControlRegistration | undefined;
  let externalHost: AppServerHost | undefined;
  let externalRunning: Promise<number> | undefined;
  let sharedListener: ReturnType<typeof createRemoteAppServerWebSocketListener> | undefined;
  let initialPeer: SharedThreadPeer | null = null;
  let promoting: Promise<SharedThreadPeer | null> | null = null;
  let closed = false;

  const startOwnerService = async (): Promise<SharedThreadOwner> => {
    const owner = new SharedThreadOwner();
    let delegation: DelegationControlRegistration | undefined;
    const host = options.createExternalHost({
      mappingStore: ownedStore,
      desktopInput: owner.input,
      desktopOutput: owner.output,
      onDelegationApi: (api) => {
        delegation = api;
        return options.registerCatalogDelegation(api);
      },
    });
    const running = host.run();
    const socketPath = sharedThreadSocketPath(options.environment);
    await prepareRemoteAppServerSocketDirectory(socketPath);
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput,
      createSession: (streams) => owner.createSession(streams),
    });
    try {
      await listener.listen();
    } catch (error) {
      await listener.close().catch(() => undefined);
      host.close();
      owner.close();
      await running.catch(() => undefined);
      owner.output.end();
      throw error;
    }
    sharedOwner = owner;
    sharedDelegation = delegation;
    externalHost = host;
    externalRunning = running;
    sharedListener = listener;
    activeStore = ownedStore;
    if (options.onFatalError) {
      const onFatalError = options.onFatalError;
      void running.then(
        () => {
          if (!closed) onFatalError();
        },
        () => {
          if (!closed) onFatalError();
        },
      );
    }
    return owner;
  };

  const closeOwnerService = async (): Promise<void> => {
    const listener = sharedListener;
    const host = externalHost;
    const owner = sharedOwner;
    const running = externalRunning;
    sharedListener = undefined;
    externalHost = undefined;
    sharedOwner = undefined;
    externalRunning = undefined;
    sharedDelegation = undefined;
    try {
      await listener?.close();
    } finally {
      host?.close();
      owner?.close();
      await running?.catch(() => undefined);
      owner?.output.end();
    }
  };

  const tryPromoteToOwner = async (): Promise<SharedThreadPeer | null> => {
    if (closed) return null;
    if (sharedOwner) return sharedOwner.connect();
    if (promoting) return promoting;
    promoting = (async () => {
      try {
        await ownedStore.initialize();
        ownedInitialized = true;
        const owner = await startOwnerService();
        return owner.connect();
      } catch (error) {
        if (error instanceof MappingStoreError && error.code === "STORE_LOCKED") {
          return await waitForSharedThreadPeer(options.environment, peerConnectTimeoutMs);
        }
        throw error;
      } finally {
        promoting = null;
      }
    })();
    return promoting;
  };

  try {
    await ownedStore.initialize();
    ownedInitialized = true;
  } catch (error) {
    if (!(error instanceof MappingStoreError) || error.code !== "STORE_LOCKED") {
      throw error;
    }
    const peer = await waitForSharedThreadPeer(options.environment, peerConnectTimeoutMs);
    if (!peer) {
      throw error;
    }
    initialPeer = peer;
    fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-shared-peer-store-"));
    fallbackStore = new MappingStore({
      directory: fallbackDirectory,
    });
    await fallbackStore.initialize();
    activeStore = fallbackStore;
  }

  if (ownedInitialized) {
    const existingPeer = await connectSharedThreads(options.environment).catch(() => null);
    if (existingPeer) {
      existingPeer.close();
      if (options.ownerRole === "local Host Runtime") {
        // Another process owns codexhost-threads.sock with a separate Mapping Store.
        return {
          mappingStore: ownedStore,
          get sharedDelegation() {
            return undefined;
          },
          createBridge(bridgeDiagnosticOutput) {
            return new SharedThreadBridge({
              connect: () => connectSharedThreads(options.environment),
              delegateCreates: false,
              diagnose: (error) =>
                bridgeDiagnosticOutput.write(`codexhost shared Threads: ${String(error)}\n`),
            });
          },
          async close() {
            closed = true;
            await ownedStore.close();
          },
        };
      }
    }
    try {
      await startOwnerService();
    } catch (error) {
      await ownedStore.close().catch(() => undefined);
      throw error;
    }
  }

  const delegatingStore = createDelegatingExternalThreadStore(() => activeStore);

  const connect = async (): Promise<SharedThreadPeer | null> => {
    if (closed) return null;
    if (sharedOwner) return sharedOwner.connect();
    if (initialPeer) {
      const peer = initialPeer;
      initialPeer = null;
      return peer;
    }
    const peer = await connectSharedThreads(options.environment).catch(() => null);
    if (peer) return peer;
    return await tryPromoteToOwner();
  };

  return {
    mappingStore: delegatingStore,
    get sharedDelegation() {
      return sharedDelegation;
    },
    createBridge(bridgeDiagnosticOutput) {
      return new SharedThreadBridge({
        connect,
        delegateCreates: true,
        diagnose: (error) =>
          bridgeDiagnosticOutput.write(`codexhost shared Threads: ${String(error)}\n`),
      });
    },
    async close() {
      closed = true;
      initialPeer?.close();
      initialPeer = null;
      try {
        await closeOwnerService();
      } finally {
        try {
          if (ownedInitialized) {
            await ownedStore.close();
          }
        } finally {
          try {
            await fallbackStore?.close();
          } finally {
            if (fallbackDirectory) {
              await rm(fallbackDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
          }
        }
      }
    },
  };
}
