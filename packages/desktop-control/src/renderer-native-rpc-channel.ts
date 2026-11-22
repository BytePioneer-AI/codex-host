import type {
  NativeRpcComponents,
  NativeOwnedManager,
  NativeRpcTransport,
} from "./renderer-native-rpc-contracts.js";

/** Native RPC preserves subscription callbacks and lease semantics. Keep the
 * MessagePort payload structured so Desktop's draft-carrier policy still runs. */
export function createNativeRpcChannel(
  components: NativeRpcComponents,
  manager: NativeOwnedManager,
) {
  const channel = new MessageChannel();
  const transports: NativeRpcTransport[] = [];
  const transport = (port: typeof channel.port1): NativeRpcTransport => {
    const values: string[] = [];
    const readers: { resolve(value: string): void; reject(error: unknown): void }[] = [];
    let closed = false;
    let failure: unknown;
    port.addEventListener("message", (event: Event) => {
      const value = JSON.stringify((event as Event & { data: unknown }).data);
      const reader = readers.shift();
      if (reader) reader.resolve(value);
      else values.push(value);
    });
    port.start();
    const result: NativeRpcTransport = {
      send(message) {
        if (closed) throw failure;
        port.postMessage(JSON.parse(message));
      },
      receive() {
        if (closed) return Promise.reject(failure);
        const value = values.shift();
        return value !== undefined
          ? Promise.resolve(value)
          : new Promise((resolve, reject) => readers.push({ resolve, reject }));
      },
      abort(error) {
        if (closed) return;
        closed = true;
        failure = error ?? new Error("Remote Control RPC manager retired");
        values.length = 0;
        for (const reader of readers.splice(0)) reader.reject(failure);
        port.close();
      },
    };
    transports.push(result);
    return result;
  };
  try {
    new components.RpcSession(transport(channel.port1), new components.RpcManager(() => manager));
    const session = new components.RpcSession(transport(channel.port2));
    const rpc = session.getRemoteMain();
    return {
      rpc,
      dispose() {
        rpc[Symbol.dispose]();
        for (const transport of transports) transport.abort();
      },
    };
  } catch (error) {
    for (const transport of transports) transport.abort(error);
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
}
