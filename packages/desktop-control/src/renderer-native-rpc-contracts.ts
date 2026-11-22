import type { RendererNativeRequestManager } from "./renderer-host-discovery.js";
import type { RendererHostRequestBridge } from "./renderer-draft-prewarm-runtime.js";
import type { RendererHostRpcStore } from "./renderer-host-rpc-discovery.js";

/** References to Desktop-owned objects. Implementations remain in Desktop. */
export interface NativeRpcLease extends Disposable {
  onRpcBroken(listener: (error: unknown) => void): void;
}
export interface NativeRpcResult<T> extends Promise<T>, NativeRpcLease {}
export interface NativeRpcManager extends NativeRpcLease {
  dup(): NativeRpcManager;
  getCodexHome(): NativeRpcResult<string>;
  sendRequest(method: string, params: unknown, options?: unknown): NativeRpcResult<unknown>;
  getConversation(threadId: string): NativeRpcResult<unknown>;
  getWorkInProgress(): NativeRpcResult<unknown>;
  subscribe(
    input: { key: { hostId: string }; listener(value: unknown): void } & (
      { type: "event"; event: string } | { type: "notification"; methods: readonly string[] }
    ),
  ): NativeRpcResult<NativeRpcLease>;
}
export type NativeRpcState =
  | { status: "ready"; manager: NativeRpcManager }
  | { status: "disconnected" | "connecting" | "replaced" };
export interface NativeRpcManagerService extends NativeRpcLease {
  dup(): NativeRpcManagerService;
  openAccount(hostId: string): unknown;
  subscribe(
    hostId: string,
    listener: (state: NativeRpcState) => void,
  ): NativeRpcResult<NativeRpcLease>;
}
export interface NativeRpcController {
  forHost(hostId: string): NativeRpcManager;
  collectAppStateSnapshot(hostId: string, options: unknown): unknown;
  getReviewPaneSnapshotMetrics(hostId: string): unknown;
  dispose(): void;
}
export interface NativeScope {
  node: RendererHostRpcStore & { parent?: NativeScope["node"] };
  get(definition: unknown, key?: string): unknown;
  watch(listener: (scope: Pick<NativeScope, "get">) => void): () => void;
}
export interface NativeRequestClient extends RendererHostRequestBridge {
  getAppServerVersion(): unknown;
  setAppServerVersion(version: unknown): void;
  dispatchMessage(type: string, payload: unknown): unknown;
  requestPromises: Map<unknown, unknown>;
  queuedRequests: unknown[];
}
export interface NativeOwnedManager extends RendererNativeRequestManager {
  getConversation(id: string): { threadAccess?: unknown } | undefined;
  sendAppServerResponse: RendererNativeRequestManager["dispatchAppServerResponse"];
}
export interface NativeRpcTransport {
  send(message: string): void;
  receive(): Promise<string>;
  abort(error?: unknown): void;
}
export interface NativeRpcComponents {
  scope: NativeScope;
  controller: NativeRpcController;
  services: { appServerManagers: NativeRpcManagerService };
  requestDefinition: unknown;
  imageDefinition: unknown;
  isHostForConversation(scope: NativeScope, hostId: string, threadId: string): boolean;
  createManager(
    scope: NativeScope,
    hostId: string,
    client: NativeRequestClient,
    isHostForConversation: (hostId: string, threadId: string) => boolean,
    imageState: (get: (definition: unknown, id: string) => unknown, id: string) => unknown,
    options: { dispatchMessageFromView(type: string, payload: unknown): unknown },
  ): NativeOwnedManager;
  Manager: { dispose(manager: NativeOwnedManager): void };
  RpcManager: new (manager: () => NativeOwnedManager) => object;
  RpcSession: new (
    transport: NativeRpcTransport,
    main?: object,
  ) => {
    getRemoteMain(): NativeRpcManager;
  };
  createController(scope: NativeScope, service: NativeRpcManagerService): NativeRpcController;
}
