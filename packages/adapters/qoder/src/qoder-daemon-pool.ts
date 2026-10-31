import type { QoderOptions } from "./qoder-sdk-types.js";

export type QoderSdkDaemon = NonNullable<QoderOptions["daemon"]>;

/**
 * Launch configuration owned by a daemon. SDK 1.0.58 rejects these options on a
 * daemon-bound Query, so they must reach the CLI through the daemon instead.
 */
export interface QoderDaemonConfig {
  auth: NonNullable<QoderOptions["auth"]>;
  env: Record<string, string | undefined>;
  pathToQoderCLIExecutable?: string;
  stderr?: (data: string) => void;
}

export type QoderStartDaemon = (config: QoderDaemonConfig) => Promise<QoderSdkDaemon>;

export interface QoderDaemonLease {
  readonly daemon: QoderSdkDaemon;
  /** Recent daemon stderr, for login diagnostics. */
  stderr(): string;
  /** Idempotent. The daemon stops when its last lease is released. */
  release(): Promise<void>;
}

interface DaemonEntry {
  readonly ready: Promise<QoderSdkDaemon>;
  users: number;
  stderr: string;
  stopped?: Promise<void>;
}

const STDERR_TAIL_LIMIT = 8192;

export function qoderDaemonConfigKey(config: QoderDaemonConfig): string {
  const env = Object.entries(config.env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    pathToQoderCLIExecutable: config.pathToQoderCLIExecutable ?? null,
    auth: config.auth,
    env,
  });
}

/**
 * Daemons keyed by their full launch configuration, including per-Thread env such
 * as CODEXHOST_THREAD_ID. Leases are reference-counted so a daemon is never
 * stopped while an inspection probe or Session still uses it, and concurrent
 * acquisitions of the same configuration share one start.
 */
export class QoderDaemonPool {
  readonly #start: QoderStartDaemon;
  readonly #entries = new Map<string, DaemonEntry>();
  #closed = false;

  constructor(start: QoderStartDaemon) {
    this.#start = start;
  }

  async acquire(config: QoderDaemonConfig): Promise<QoderDaemonLease> {
    if (this.#closed) throw new Error("Qoder adapter is closed");
    const key = qoderDaemonConfigKey(config);
    let entry = this.#entries.get(key);
    if (!entry) {
      const created: DaemonEntry = {
        users: 0,
        stderr: "",
        ready: Promise.resolve().then(() =>
          this.#start({
            ...config,
            stderr: (data) => {
              created.stderr = (created.stderr + data).slice(-STDERR_TAIL_LIMIT);
              config.stderr?.(data);
            },
          }),
        ),
      };
      created.ready.catch(() => {
        if (this.#entries.get(key) === created) this.#entries.delete(key);
      });
      this.#entries.set(key, created);
      entry = created;
    }

    const leased = entry;
    leased.users += 1;
    let daemon: QoderSdkDaemon;
    try {
      daemon = await leased.ready;
    } catch (error) {
      leased.users -= 1;
      throw error;
    }
    if (this.#closed) {
      // close() already stopped this daemon.
      leased.users -= 1;
      throw new Error("Qoder adapter is closed");
    }

    let released = false;
    return {
      daemon,
      stderr: () => leased.stderr,
      release: async () => {
        if (released) return;
        released = true;
        leased.users -= 1;
        if (leased.users > 0) return;
        if (this.#entries.get(key) === leased) this.#entries.delete(key);
        await stopQuietly(leased);
      },
    };
  }

  /** Stops every daemon, waiting for starts that are still in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(stopQuietly));
  }
}

function stopQuietly(entry: DaemonEntry): Promise<void> {
  entry.stopped ??= (async () => {
    try {
      const daemon = await entry.ready;
      await daemon.stop();
    } catch {
      // A failed start has nothing to stop; a stop failure must not block shutdown.
    }
  })();
  return entry.stopped;
}
