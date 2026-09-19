/** Serialized into an owned Electron RUN_AS_NODE helper. No imports/closures outside this function.
 * The helper loads the installed native codec, not the Desktop main/Host entry point. */
export async function desktopWorker() {
  const { readFile } = await import("node:fs/promises");
  const { createInterface } = await import("node:readline");
  type ObjectValue = Record<string, unknown>;
  type Disposable = { dispose(): void };
  type NativeChannel = {
    call(method: string, args: unknown[]): Promise<unknown>;
    listen(method: string, args: unknown[]): (listener: (value: unknown) => void) => Disposable;
  };
  type Rpc = Disposable & { getChannel(name: string): NativeChannel };
  type Codec = Disposable & {
    protocol: unknown;
    acceptPayload(payload: unknown): void;
    onDegraded(callback: () => void): Disposable;
  };
  const object = (value: unknown): ObjectValue =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  console.log = console.warn = console.error = () => {};
  const fail = () => {
    send({ type: "fault" });
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  let rpc: Rpc | undefined, codec: Codec | undefined;
  const subscriptions = new Map<string, Disposable>();
  const calls = new Set([
    "createSession",
    "resumeSession",
    "readSession",
    "readSessionEvents",
    "listSessionSubagents",
    "readWorkspacePresentation",
    "closeSession",
    "setModel",
    "setThoughtLevel",
    "setMode",
    "sendPrompt",
    "compactSession",
    "goalSession",
    "getTaskTokenUsage",
    "helloConversationV4",
    "initializeConversationV4",
    "sendConversationCommandV4",
    "subscribeConversationV4",
    "unsubscribeConversationV4",
    "conversationRowsRangeV4",
    "conversationFileChangesV4",
  ]);
  const events = new Set(["onDynamicSessionEvent", "onDynamicConversationFrame"]);
  async function receive(message: ObjectValue) {
    if (message.type === "init") {
      if (rpc || typeof message.archive !== "string") throw new Error();
      const archive = message.archive;
      if (
        object(JSON.parse(await readFile(`${archive}/package.json`, "utf8"))).version !== "3.12.3"
      )
        throw new Error();
      const nativeRpc: ObjectValue = await import(`${archive}/out/host/chunk-PRPNU2MC.js`);
      const nativeRelay: ObjectValue = await import(`${archive}/out/main/chunk-E6IDJBYU.js`);
      const exported = (module: ObjectValue, name: string) => {
        const found = Object.values(module).filter(
          (value) => typeof value === "function" && value.name === name,
        );
        if (found.length !== 1) throw new Error();
        return found[0];
      };
      const Client = exported(nativeRpc, "ChannelClient") as new (protocol: unknown) => Rpc;
      const create = exported(nativeRelay, "createAcknowledgedWebRemoteControlRelayProtocol") as (
        options: ObjectValue,
      ) => Codec;
      codec = create({
        ...object(message.identity),
        sendFrame: (payload: unknown) => {
          send({ type: "frame", payload });
          return true;
        },
      });
      codec.onDegraded(fail);
      rpc = new Client(codec.protocol);
      send({ type: "ready" });
    } else if (message.type === "frame") {
      if (!codec) throw new Error();
      codec.acceptPayload(message.payload);
    } else if (message.type === "request") {
      const id = message.id;
      try {
        if (!rpc || typeof message.method !== "string") throw new Error();
        const channel = rpc.getChannel("zcode-agent");
        let result: unknown;
        if (message.method === "unsubscribe") {
          const key = String(message.key);
          subscriptions.get(key)?.dispose();
          subscriptions.delete(key);
        } else if (events.has(message.method)) {
          const key = String(message.key);
          subscriptions.get(key)?.dispose();
          subscriptions.set(
            key,
            channel.listen(message.method, [message.params])((value) => {
              const data = object(value);
              // Authentication challenges belong to Desktop, never to the Host or Renderer.
              if (
                message.method === "onDynamicSessionEvent" &&
                ![
                  "session.event",
                  "state.updated",
                  "permission.request",
                  "userInput.request",
                  "snapshot",
                ].includes(String(data.type))
              )
                return;
              send({ type: "event", key, value });
            }),
          );
        } else {
          if (!calls.has(message.method)) throw new Error();
          result = await channel.call(message.method, [message.params]);
        }
        send({ type: "result", id, result: result ?? null });
      } catch (error) {
        // Never forward an exception body/stack: it may contain native auth state.
        const code = object(error).code;
        send({ type: "result", id, error: typeof code === "number" ? code : -32603 });
      }
    } else throw new Error();
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) return fail();
    try {
      void receive(object(JSON.parse(line))).catch(fail);
    } catch {
      fail();
    }
  });
  lines.on("close", () => {
    for (const subscription of subscriptions.values()) subscription.dispose();
    rpc?.dispose();
    codec?.dispose();
    process.exit(0);
  });
}
