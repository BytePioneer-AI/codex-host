import {
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type RpcHandler,
  type StreamHandler,
  type StreamSink,
} from "./transport.ts";

class SourceRpcRegistry extends RpcRegistry {
  private readonly methods = new Set<string>();

  override register(method: string, handler: RpcHandler): void {
    super.register(method, handler);
    this.methods.add(method);
  }

  names(): string[] {
    return [...this.methods];
  }

  async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.dispatch(method, { args });
    if (!result.ok)
      throw new RpcError(result.error.code, result.error.message, result.error.details);
    return result.value;
  }
}

class SourceStreamRegistry extends StreamRegistry {
  private readonly endpoints = new Map<string, StreamHandler>();

  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }

  names(): string[] {
    return [...this.endpoints.keys()];
  }

  async open(name: string, args: Record<string, unknown>, sink: StreamSink): Promise<void> {
    if (sink.closed) return;
    const handler = this.endpoints.get(name);
    if (!handler) throw new RpcError("gateway/not-found", `No session source stream: ${name}`);
    await handler(args, sink);
  }
}

/** Capture an existing source's registration without exposing its endpoints directly. */
export class SourceEndpoints {
  readonly rpc = new SourceRpcRegistry();
  readonly streams = new SourceStreamRegistry();
}

export interface SessionControlSource {
  open(sink: StreamSink): void | Promise<void>;
  /** Evaluated on delivery so a draft can mask the source's canonical session. */
  accepts(sessionId: string): boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge authoritative sources into the single baseline expected by the browser. */
export async function mergeSessionControls(
  sources: readonly SessionControlSource[],
  sink: StreamSink,
): Promise<void> {
  if (sink.closed) return;
  let closed = false;
  let ready = false;
  const stopped = Promise.withResolvers<undefined>();
  const states = sources.map(() => ({
    baseline: undefined as Record<string, unknown> | undefined,
    listeners: [] as Array<() => void>,
  }));
  const pending: Array<{ index: number; value: Record<string, unknown> }> = [];
  const owners = new Map<string, number>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    owners.clear();
    for (const state of states) {
      state.baseline = undefined;
      for (const listener of state.listeners.splice(0)) {
        try {
          listener();
        } catch (error) {
          console.error("[session/control] source cleanup failed", error);
        }
      }
    }
    stopped.resolve(undefined);
  };
  const fail = (code: string, message: string): void => {
    if (closed || sink.closed) return;
    close();
    sink.fail(code, message);
  };
  const failError = (error: unknown): void => {
    fail(
      error instanceof RpcError ? error.code : "gateway/internal",
      error instanceof Error ? error.message : String(error),
    );
  };
  sink.onClose(close);

  const accepts = (index: number, id: string): boolean => {
    if (!sources[index]?.accepts(id)) return false;
    const owner = owners.get(id);
    if (owner !== undefined && owner !== index && sources[owner]?.accepts(id)) {
      throw new RpcError("session/source-collision", `Multiple session sources own ${id}`);
    }
    owners.set(id, index);
    return true;
  };
  const deliver = (index: number, value: Record<string, unknown>): void => {
    if (!closed && !sink.closed && accepts(index, String(value.sessionId))) sink.push(value);
  };
  const baseline = (): void => {
    if (ready || closed || sink.closed || states.some((state) => state.baseline === undefined))
      return;
    const projections = new Map<string, unknown>();
    for (const [index, state] of states.entries()) {
      for (const [id, value] of Object.entries(state.baseline ?? {}))
        if (accepts(index, id)) projections.set(id, value);
    }
    ready = true;
    sink.push({ type: "baseline", value: { projections: Object.fromEntries(projections) } });
    for (const { index, value } of pending.splice(0)) deliver(index, value);
  };

  const children: StreamSink[] = states.map((state, index) => ({
    id: `${sink.id}:source:${index}`,
    get closed() {
      return closed || sink.closed;
    },
    push(value) {
      if (closed || sink.closed) return;
      try {
        if (!record(value)) throw new RpcError("session/control-invalid", "Invalid control frame");
        if (value.type === "baseline") {
          if (state.baseline !== undefined)
            throw new RpcError("session/control-invalid", "Duplicate source baseline");
          if (!record(value.value) || !record(value.value.projections))
            throw new RpcError("session/control-invalid", "Invalid source baseline");
          state.baseline = value.value.projections;
          baseline();
        } else {
          if (state.baseline === undefined || typeof value.sessionId !== "string")
            throw new RpcError(
              "session/control-invalid",
              "Control delta requires a source baseline and session ID",
            );
          if (ready) deliver(index, value);
          else pending.push({ index, value });
        }
      } catch (error) {
        failError(error);
      }
    },
    end: () => fail("session/source-ended", "A session source ended; reconnect to restore state"),
    fail,
    onClose(listener) {
      if (closed || sink.closed) listener();
      else state.listeners.push(listener);
    },
  }));

  if (sources.length === 0) baseline();
  const opened = Promise.all(
    sources.map(async (source, index) => {
      if (closed || sink.closed) return;
      const child = children[index];
      const state = states[index];
      if (!child || !state) return;
      try {
        await source.open(child);
        if (!closed && !sink.closed && state.baseline === undefined)
          fail("session/control-invalid", "Session source did not provide a baseline");
      } catch (error) {
        failError(error);
      }
    }),
  );
  await Promise.race([opened, stopped.promise]);
}
