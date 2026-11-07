/** Browser-visible liveness checks for one physical Remote stream socket. */
export interface StreamHeartbeatOptions {
  /** Idle time before probing the connection. Default: 25000ms. */
  readonly intervalMs?: number;
  /** Deadline for the matching reply. Default: 10000ms. */
  readonly timeoutMs?: number;
  /** Deadline for a probe requested when the page returns to the foreground. Default: 2000ms. */
  readonly restoreTimeoutMs?: number;
}

export class StreamHeartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string | undefined;
  private sequence = 0;
  private lastActivity = Date.now();
  private stopped = false;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly restoreTimeout: number;

  constructor(
    private readonly send: (id: string) => void,
    private readonly failed: () => void,
    options: StreamHeartbeatOptions = {},
  ) {
    this.interval = options.intervalMs ?? 25_000;
    this.timeout = options.timeoutMs ?? 10_000;
    this.restoreTimeout = options.restoreTimeoutMs ?? 2_000;
    this.schedule(this.interval);
  }

  /** Valid inbound traffic postpones an idle probe, but cannot acknowledge a pending one. */
  received(pongId?: string): void {
    if (this.stopped) return;
    this.lastActivity = Date.now();
    if (this.pending !== undefined && pongId === this.pending) {
      this.pending = undefined;
      this.schedule(this.interval);
    }
  }

  /** Check the socket now. A reply to any earlier probe no longer counts. */
  probe(): void {
    if (!this.stopped) this.sendProbe(this.restoreTimeout);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending = undefined;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (this.stopped) return;
    // Background timers may be frozen. Foreground restoration requests its own probe.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.pending = undefined;
      this.lastActivity = Date.now();
      this.schedule(this.interval);
      return;
    }
    if (this.pending !== undefined) {
      this.stop();
      this.failed();
      return;
    }
    const remaining = this.interval - (Date.now() - this.lastActivity);
    if (remaining > 0) {
      this.schedule(remaining);
      return;
    }
    this.sendProbe(this.timeout);
  }

  private sendProbe(timeout: number): void {
    this.pending = `heartbeat-${String(++this.sequence)}`;
    this.schedule(timeout);
    try {
      this.send(this.pending);
    } catch {
      this.stop();
      this.failed();
    }
  }
}
