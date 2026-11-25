/**
 * Supervisor loss detection for the managed remote Unix listener.
 *
 * The native Shim starts the listener as a child of a long-lived supervisor
 * process that owns the listener process tree and is the only reader of the
 * listener's stdout and stderr pipes. Codex Desktop's reconnect cleanup runs
 * `pkill -9 -f 'codex.* app-server.* --listen'`, which matches that supervisor
 * and the stock Codex process but not the retitled listener. The surviving
 * listener would be unsupervised, and its next diagnostic write would fail with
 * EPIPE and crash the process without releasing the control socket.
 *
 * The listener instead treats supervisor loss as a shutdown request so that its
 * normal close path releases the control socket and every owned resource.
 */

interface ErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface RemoteListenerSupervisorWatch {
  close(): void;
}

export interface RemoteListenerSupervisorOptions {
  /** Called once when the supervisor is gone. */
  onLost(reason: string): void;
  /** Streams read by the supervisor. Defaults to process stdout and stderr. */
  outputs?: readonly ErrorEmitter[];
  /** Current parent process id. Defaults to `process.ppid`, which is live on Unix. */
  parentProcessId?: () => number;
  /**
   * The listener must have a supervisor. An initial init-like parent then means
   * the supervisor was already killed before the watch started, and `onLost` is
   * called synchronously before this function returns.
   */
  supervisorRequired?: boolean;
  intervalMs?: number;
}

const DEFAULT_SUPERVISOR_POLL_INTERVAL_MS = 1_000;

export function watchRemoteListenerSupervisor(
  options: RemoteListenerSupervisorOptions,
): RemoteListenerSupervisorWatch {
  const parentProcessId = options.parentProcessId ?? (() => process.ppid);
  const outputs: readonly ErrorEmitter[] = options.outputs ?? [process.stdout, process.stderr];
  const supervisor = parentProcessId();
  let lost = false;
  let timer: NodeJS.Timeout | undefined;

  const lose = (reason: string): void => {
    if (lost) return;
    lost = true;
    if (timer) clearInterval(timer);
    options.onLost(reason);
  };

  // The supervisor is the only reader of these pipes. A failed diagnostic write
  // must never crash the listener; EPIPE also proves the reader is gone. The
  // handlers stay installed for the remaining process lifetime because shutdown
  // itself may still write diagnostics.
  for (const output of outputs) {
    output.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") lose("diagnostic output reader closed");
    });
  }

  // A listener that already belongs to init (or an init-like parent) has no
  // supervisor to watch. When one is required, the Shim was killed while the
  // listener was still starting and the listener was reparented before this
  // watch could record its parent. Otherwise a reparented listener has lost its
  // Shim.
  if (supervisor <= 1) {
    if (options.supervisorRequired) lose("supervisor exited before startup completed");
  } else {
    timer = setInterval(() => {
      if (parentProcessId() !== supervisor) lose(`supervisor process ${supervisor} exited`);
    }, options.intervalMs ?? DEFAULT_SUPERVISOR_POLL_INTERVAL_MS);
    timer.unref();
  }

  return {
    close() {
      // Keep the error handlers: late shutdown diagnostics must not crash.
      lost = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
