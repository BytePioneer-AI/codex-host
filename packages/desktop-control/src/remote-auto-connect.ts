export interface AutoConnectControl {
  list(): Promise<readonly { hostId: string; autoConnect: boolean }[]>;
  state(hostId: string): Promise<{ state: string; error?: unknown } | null>;
  connect(hostId: string, enabled: boolean): Promise<void>;
}

/** SSH recovery shares the Controller/Web polling cadence. Native writes with
 * unknown outcomes stay blocked until an explicit operation or a connection succeeds. */
export function createAutoConnectRestore(control: AutoConnectControl) {
  type Attempt = { failures: number; retryAt: number; loading?: Promise<boolean> };
  const attempts = new Map<string, Attempt>();
  let disposed = false;
  return {
    restore(hostId: string): Promise<boolean> {
      if (disposed || !/^remote-ssh(?:-|:)/u.test(hostId)) return Promise.resolve(false);
      const attempt = attempts.get(hostId);
      if (attempt?.loading) return attempt.loading;
      if (attempt && Date.now() < attempt.retryAt) {
        // Observing a successful native reconnect also releases an unknown outcome.
        return control.state(hostId).then(
          (status) => {
            if (attempts.get(hostId) !== attempt || status?.state !== "connected") return false;
            attempts.delete(hostId);
            return true;
          },
          () => false,
        );
      }
      const current: Attempt = { failures: attempt?.failures ?? 0, retryAt: Infinity };
      attempts.set(hostId, current);
      const active = () => !disposed && attempts.get(hostId) === current;
      current.loading = Promise.resolve().then(async () => {
        let dispatched = false;
        try {
          const hosts = await control.list();
          if (!active()) return false;
          if (!hosts.some((host) => host.hostId === hostId && host.autoConnect)) {
            attempts.delete(hostId);
            return false;
          }
          const status = await control.state(hostId);
          if (!active()) return false;
          if (status?.state === "connected") {
            attempts.delete(hostId);
            return true;
          }
          if (status?.state !== "disconnected" && status?.state !== "error") {
            attempts.delete(hostId);
            return false;
          }
          const latest = await control.list();
          if (!active()) return false;
          if (!latest.some((host) => host.hostId === hostId && host.autoConnect)) {
            attempts.delete(hostId);
            return false;
          }
          let acknowledged = false;
          let failureCode: unknown;
          try {
            dispatched = true;
            await control.connect(hostId, false);
            if (!active()) return false;
            // The off write is temporary. Explicit connect/disconnect/remove operations
            // cancel this attempt before their own native write; no reenable debt survives.
            const afterOff = await control.list();
            if (!active() || !afterOff.some((host) => host.hostId === hostId)) return false;
            await control.connect(hostId, true);
            acknowledged = true;
          } catch (error) {
            failureCode = (error as { code?: unknown } | null)?.code;
          }
          if (!active()) return false;
          const result = await control.state(hostId);
          if (!active()) return false;
          if (result?.state === "connected") {
            attempts.delete(hostId);
            return true;
          }
          const failed =
            acknowledged ||
            [
              "ECONNREFUSED",
              "ECONNRESET",
              "ENETUNREACH",
              "EHOSTUNREACH",
              "ENOTFOUND",
              "EAI_AGAIN",
            ].includes(String(failureCode));
          if (
            failed &&
            (result?.state === "disconnected" || result?.state === "error") &&
            result.error
          ) {
            current.failures = Math.min(current.failures + 1, 4);
            current.retryAt = Date.now() + Math.min(30_000, 5_000 * 2 ** (current.failures - 1));
          }
          return false;
        } catch {
          // An observation before dispatch can be retried; a submitted write cannot.
          if (!dispatched && active()) attempts.delete(hostId);
          return false;
        } finally {
          delete current.loading;
        }
      });
      return current.loading;
    },
    runExplicit(hostId: string, operation: () => Promise<void>): Promise<void> {
      const previous = attempts.get(hostId)?.loading;
      const current: Attempt = { failures: 0, retryAt: Infinity };
      // Invalidate before awaiting an in-flight native operation. Explicit operations
      // queue behind it so a late automatic on cannot follow the user's off.
      attempts.set(hostId, current);
      current.loading = Promise.resolve(previous)
        .catch(() => false)
        .then(async () => {
          if (disposed) return false;
          await operation();
          if (attempts.get(hostId) === current) attempts.delete(hostId);
          return false;
        })
        .finally(() => {
          delete current.loading;
        });
      return current.loading.then(() => undefined);
    },
    dispose(): void {
      disposed = true;
      attempts.clear();
    },
  };
}
