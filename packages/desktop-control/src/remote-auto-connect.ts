/** Native SSH hosts whose auto-connect flag is already on.
 * Turning the flag on again does not reopen a host that already has it set,
 * so a disconnected or failed host is switched off and back on.
 * A host the user turned off stays off. A host that is already connecting is
 * left alone. A state read that fails is not a reason to switch the flag.
 * If this restore turns the flag off and the on request fails, later passes
 * keep requesting on until that request succeeds. */

export const AUTO_CONNECT_RESTORE_ATTEMPTS = 5;
export const AUTO_CONNECT_RESTORE_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

export interface AutoConnectRecord {
  hostId: string;
  autoConnect: boolean;
}

export interface AutoConnectControl {
  list(): Promise<readonly AutoConnectRecord[]>;
  state(hostId: string): Promise<{ state: string } | null>;
  connect(hostId: string, enabled: boolean): Promise<void>;
}

export interface AutoConnectMemory {
  attempts: Map<string, number>;
  /** Hosts whose auto-connect flag this restore turned off and must turn back on. */
  reenable: Set<string>;
  busy: boolean;
  /** Installed with Desktop startup recovery. Web host-list reads call it too. */
  onConnected?: (hostId: string) => void;
}

export function autoConnectMemory(target: object): AutoConnectMemory {
  const holder = target as { __codexhostAutoConnectRestoreV1?: AutoConnectMemory };
  return (holder.__codexhostAutoConnectRestoreV1 ??= {
    attempts: new Map(),
    reenable: new Set(),
    busy: false,
  });
}

/** One pass. Returns SSH hosts that are connected when the pass finishes.
 * Null means another pass is already running.
 * The function body is injected into Desktop, so it must not call other module bindings. */
export async function restoreDisconnectedAutoConnect(
  control: AutoConnectControl,
  memory: AutoConnectMemory,
  maxAttempts = 5,
): Promise<readonly string[] | null> {
  if (memory.busy) return null;
  memory.busy = true;
  try {
    const connected: string[] = [];
    let hosts: readonly AutoConnectRecord[];
    try {
      hosts = await control.list();
    } catch {
      return connected;
    }
    if (!Array.isArray(hosts)) return connected;
    const ssh = hosts.filter(
      (host) =>
        !!host &&
        typeof host.hostId === "string" &&
        typeof host.autoConnect === "boolean" &&
        /^remote-ssh(?:-|:)/u.test(host.hostId),
    );
    const seen = new Set(ssh.map((host) => host.hostId));
    for (const hostId of memory.attempts.keys())
      if (!seen.has(hostId)) memory.attempts.delete(hostId);
    for (const hostId of memory.reenable) if (!seen.has(hostId)) memory.reenable.delete(hostId);
    for (const host of ssh) {
      if (!host.autoConnect) {
        if (!memory.reenable.has(host.hostId)) {
          memory.attempts.delete(host.hostId);
          continue;
        }
        try {
          await control.connect(host.hostId, true);
          memory.reenable.delete(host.hostId);
        } catch {
          // The flag is still off. A later pass turns it back on.
        }
        continue;
      }
      let status: { state: string } | null;
      try {
        status = await control.state(host.hostId);
      } catch {
        continue;
      }
      if (!status || typeof status.state !== "string") continue;
      if (status.state === "connected") {
        memory.attempts.delete(host.hostId);
        memory.reenable.delete(host.hostId);
        connected.push(host.hostId);
        continue;
      }
      if (status.state !== "disconnected" && status.state !== "error") continue;
      const used = memory.attempts.get(host.hostId) ?? 0;
      if (used >= maxAttempts) continue;
      memory.attempts.set(host.hostId, used + 1);
      memory.reenable.add(host.hostId);
      try {
        await control.connect(host.hostId, false);
      } catch {
        // The off request may still have landed. The on request puts the flag back.
      }
      try {
        await control.connect(host.hostId, true);
        memory.reenable.delete(host.hostId);
      } catch {
        // The next pass reads state before switching the flag again.
      }
      try {
        const after = await control.state(host.hostId);
        if (after?.state === "connected") {
          memory.attempts.delete(host.hostId);
          memory.reenable.delete(host.hostId);
          connected.push(host.hostId);
        }
      } catch {
        // Outcome unknown until a later pass can read state.
      }
    }
    return connected;
  } finally {
    memory.busy = false;
  }
}

export function startAutoConnectRestore(
  owner: object,
  control: AutoConnectControl,
  timers: {
    setTimeout(handler: () => void, delayMs: number): unknown;
    clearTimeout(id: unknown): void;
  },
  options?: {
    delaysMs?: readonly number[];
    onConnected?: (hostId: string) => void;
  },
): { dispose(): void } {
  const delays = options?.delaysMs ?? AUTO_CONNECT_RESTORE_DELAYS_MS;
  const memory = autoConnectMemory(owner);
  const notify = options?.onConnected;
  if (notify) memory.onConnected = notify;
  else delete memory.onConnected;
  let epoch = 0;
  let timer: unknown;
  const schedule = (index: number): void => {
    if (index >= delays.length) return;
    const scheduled = epoch;
    timer = timers.setTimeout(() => {
      void (async () => {
        if (scheduled !== epoch) return;
        const connected = await restoreDisconnectedAutoConnect(control, memory);
        if (scheduled !== epoch) return;
        if (connected)
          for (const hostId of connected) {
            try {
              notify?.(hostId);
            } catch {
              // A single host notification must not skip later rounds.
            }
          }
        schedule(index + 1);
      })();
    }, delays[index] ?? 0);
  };
  schedule(0);
  return {
    dispose() {
      epoch += 1;
      if (timer !== undefined) timers.clearTimeout(timer);
      if (memory.onConnected === notify) delete memory.onConnected;
    },
  };
}
