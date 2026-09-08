import type {
  HarnessCommandCapability,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HostCommand,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";

/** Exclusive access is local to this Host; it makes no claim about other native clients. */
export interface ExternalSessionLease {
  readonly source: HarnessSession;
  snapshot?: HostThreadSnapshot;
  invalidated: boolean;
  draining: boolean;
  sourceClosed: boolean;
  readonly outputGate: PromiseWithResolvers<undefined>;
}

/** Tracks every public Session call, including fire-and-forget usage refresh and output projection. */
export class ExternalSessionAccess implements HarnessSession {
  readonly native: HarnessSession;
  readonly commands?: HarnessCommandCapability;
  readonly refreshUsage?: () => Promise<void>;
  readonly execute: HarnessSession["execute"];
  readonly outputs: AsyncIterable<HarnessOutput>;
  #calls = 0;
  #projections = 0;
  #closed = false;
  #lease: ExternalSessionLease | null = null;

  constructor(native: HarnessSession) {
    this.native = native;
    this.outputs = this.#outputs();
    this.execute = ((command: HostCommand) =>
      this.#result<unknown>(() => {
        switch (command.type) {
          case "turn.start":
            return native.execute(command);
          case "turn.cancel":
            return native.execute(command);
          case "interaction.respond":
            return native.execute(command);
          case "model.select":
            return native.execute(command);
          case "thinking.select":
            return native.execute(command);
          case "permissionMode.select":
            return native.execute(command);
        }
      })) as HarnessSession["execute"];
    // Read lazily: plugins may expose their command capability after initialization.
    Object.defineProperty(this, "commands", {
      get: () => {
        const commands = native.commands;
        return commands
          ? {
              list: () => this.#result(() => commands.list()),
              execute: (command: Parameters<HarnessCommandCapability["execute"]>[0]) =>
                this.#result(() => commands.execute(command)),
            }
          : undefined;
      },
    });
    if (native.refreshUsage) {
      this.refreshUsage = async () => {
        if (this.#lease || this.#closed) return;
        await this.#track(() => native.refreshUsage?.() ?? Promise.resolve());
      };
    }
  }

  get harnessId() {
    return this.native.harnessId;
  }
  get capabilities() {
    return this.native.capabilities;
  }
  get initialState() {
    return this.native.initialState;
  }
  get initialUsage() {
    return this.native.initialUsage;
  }

  readSnapshot() {
    return this.#result(() => this.native.readSnapshot());
  }

  async #result<T>(operation: () => Promise<HarnessResult<T>>): Promise<HarnessResult<T>> {
    if (this.#lease || this.#closed)
      return {
        ok: false,
        error: {
          code: this.#closed ? "invalidState" : "sessionBusy",
          message: "External Session is unavailable during history replacement",
          retryable: !this.#closed,
        },
      };
    return this.#track(operation);
  }

  async #track<T>(operation: () => Promise<T>): Promise<T> {
    this.#calls += 1;
    try {
      return await operation();
    } finally {
      this.#calls -= 1;
    }
  }

  acquire(): ExternalSessionLease | null {
    if (this.#lease || this.#closed || this.#calls || this.#projections) return null;
    this.#lease = {
      source: this.native,
      invalidated: false,
      draining: false,
      sourceClosed: false,
      outputGate: Promise.withResolvers<undefined>(),
    };
    return this.#lease;
  }

  owns(lease: ExternalSessionLease): boolean {
    return this.#lease === lease;
  }

  drain(lease: ExternalSessionLease): void {
    if (!this.owns(lease)) throw new Error("External Session lease is stale");
    lease.draining = true;
    lease.outputGate.resolve(undefined);
  }

  retire(): void {
    this.#closed = true;
  }

  release(lease: ExternalSessionLease): void {
    if (!this.owns(lease)) return;
    this.#lease = null;
    lease.outputGate.resolve(undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#lease) {
      this.#lease.invalidated = true;
      this.drain(this.#lease);
    }
    await this.native.close();
  }

  async *#outputs(): AsyncIterable<HarnessOutput> {
    for await (const output of this.native.outputs) {
      const lease = this.#lease;
      if (lease) {
        lease.invalidated = true;
        if (!lease.draining) await lease.outputGate.promise;
      }
      this.#projections += 1;
      try {
        yield output;
      } finally {
        this.#projections -= 1;
      }
    }
  }
}

/** A timed-out close remains unconfirmed; callers must retain ownership and block reuse. */
export async function settleHistoryResource<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("External history resource cleanup timed out")),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
