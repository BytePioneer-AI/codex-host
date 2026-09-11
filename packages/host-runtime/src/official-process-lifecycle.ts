import type { ChildProcess } from "node:child_process";

import type { OfficialAppServerExit } from "./official-app-server-connection.js";

export class OfficialProcessStopTimeoutError extends Error {
  constructor() {
    super("Official app-server process exit could not be confirmed");
    this.name = "OfficialProcessStopTimeoutError";
  }
}

/** Process exit, unlike EOF or a WebSocket close, permits replacing credentials. */
export class OfficialProcessLifecycle {
  readonly #child: ChildProcess;
  readonly #timeoutMs: number;
  readonly #endInput: (() => void) | undefined;
  readonly #exit = Promise.withResolvers<OfficialAppServerExit>();
  #result: OfficialAppServerExit | undefined;
  #stopping: Promise<OfficialAppServerExit> | undefined;

  constructor(child: ChildProcess, options: { timeoutMs?: number; endInput?: () => void } = {}) {
    this.#child = child;
    this.#timeoutMs = options.timeoutMs ?? 2_000;
    this.#endInput = options.endInput;
    let spawned = child.pid !== undefined;
    child.once("spawn", () => {
      spawned = true;
    });
    child.on("error", (error) => {
      // After spawn, an error can mean kill() failed, not that the process exited.
      if (!spawned && child.pid === undefined) {
        this.#settle({ code: null, signal: null, error });
      }
    });
    child.once("exit", (code, signal) => this.#settle({ code, signal }));
  }

  get closed(): Promise<OfficialAppServerExit> {
    return this.#exit.promise;
  }

  /** Best-effort hard-close for existing Host shutdown paths. Not exit evidence. */
  requestClose(): void {
    this.#signal("SIGTERM");
  }

  /** Idempotent while stopping; a timeout never resolves `closed` artificially. */
  stop(): Promise<OfficialAppServerExit> {
    if (this.#result) return Promise.resolve(this.#result);
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stop();
    this.#stopping = stopping;
    // Allow recovery after a timeout, including a late actual exit notification.
    void stopping.then(
      () => {
        this.#stopping = undefined;
      },
      () => {
        this.#stopping = undefined;
      },
    );
    return stopping;
  }

  async #stop(): Promise<OfficialAppServerExit> {
    if (this.#endInput) {
      try {
        this.#endInput();
      } catch {
        // A broken input is not proof of process exit; continue with termination.
      }
      if (await this.#waitForExit()) return this.#exit.promise;
    }
    this.#signal("SIGTERM");
    if (await this.#waitForExit()) return this.#exit.promise;
    this.#signal("SIGKILL");
    if (await this.#waitForExit()) return this.#exit.promise;
    throw new OfficialProcessStopTimeoutError();
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.#result) return;
    try {
      this.#child.kill(signal);
    } catch {
      // Only an exit or a confirmed spawn failure settles ownership.
    }
  }

  #settle(result: OfficialAppServerExit): void {
    if (this.#result) return;
    this.#result = result;
    this.#exit.resolve(result);
  }

  #waitForExit(): Promise<boolean> {
    if (this.#result) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.#timeoutMs);
      void this.#exit.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
