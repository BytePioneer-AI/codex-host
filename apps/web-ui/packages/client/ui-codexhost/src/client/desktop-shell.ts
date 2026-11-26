export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __CODEXHOST_DESKTOP_SHELL__?: boolean }).__CODEXHOST_DESKTOP_SHELL__ === true
  );
}

type SessionReply =
  | { status: "granted"; sessionId: string }
  | { status: "wake" | "discard"; generation: string }
  | { status: "retry" | "unavailable" };

type SessionReceipt = "confirmed" | "retry" | "unavailable";

type SessionPage = Window & {
  __TAURI_INTERNALS__?: {
    invoke(command: string, args: { generation?: string; document: string }): Promise<unknown>;
  };
  __codexhostOpenDesktopSession?: (generation: string, urlOnly?: boolean) => Promise<void>;
  __codexhostRefreshDesktopSession?: () => Promise<void>;
};

export const desktopSessionGenerationQuery = "desktopSessionGeneration";

const RETRY_DELAYS = [0, 100, 250];
const IPC_TIMEOUT = 500;
const retry = Symbol("retry");

function waitFor<T>(signal: AbortSignal, delay: number, expired: T, action?: () => Promise<T>) {
  if (signal.aborted) return Promise.resolve(expired);
  const { promise, resolve } = Promise.withResolvers<T>();
  const finish = (result: T) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    resolve(result);
  };
  const stop = () => finish(expired);
  const timer = setTimeout(stop, delay);
  signal.addEventListener("abort", stop, { once: true });
  // A late result after timeout or abort cannot resolve this attempt again.
  if (action)
    void Promise.resolve()
      .then(() => (signal.aborted ? expired : action()))
      .then(finish, stop);
  return promise;
}

function parseGeneration(generation: string): bigint | undefined {
  if (!/^[1-9]\d{0,19}$/.test(generation)) return undefined;
  return BigInt(generation);
}

export function attachDesktopSessionPage(openSession: (sessionId: string) => void) {
  const page: SessionPage = window;
  const document = crypto.randomUUID();
  const flights = new Map<bigint, { controller: AbortController; done: Promise<void> }>();
  let latest = 0n;
  let discarded = 0n;
  let selection: { generation: bigint; opened: boolean; acknowledged: boolean } | undefined;
  let urlGeneration: string | undefined;
  let readyCheck: AbortController | undefined;
  let paused = false;

  const invoke = async <T>(signal: AbortSignal, command: string, generation?: string) => {
    for (const delay of RETRY_DELAYS) {
      if (delay > 0) await waitFor(signal, delay, undefined);
      if (signal.aborted) break;
      const result = await waitFor<T | typeof retry>(signal, IPC_TIMEOUT, retry, async () => {
        const ipc = page.__TAURI_INTERNALS__;
        if (!ipc) return retry;
        const response = await ipc.invoke(command, { generation, document });
        if (response === "retry" || (response as SessionReply)?.status === "retry") return retry;
        return response as T;
      });
      if (result !== retry && !signal.aborted) return result;
    }
    return retry;
  };

  const wake = (generation: string, urlOnly = false): Promise<void> => {
    const current = parseGeneration(generation);
    if (
      paused ||
      current === undefined ||
      current < latest ||
      current <= discarded ||
      (urlOnly && generation !== urlGeneration)
    )
      return Promise.resolve();
    const active = flights.get(current);
    if (active) return active.done;
    const controller = new AbortController();
    const { signal } = controller;
    const done = (async () => {
      if (selection?.generation !== current) {
        const granted = await invoke<SessionReply>(signal, "desktop_session_claim", generation);
        if (
          signal.aborted ||
          current < latest ||
          current <= discarded ||
          granted === retry ||
          granted?.status !== "granted"
        )
          return;
        latest = current;
        for (const [older, flight] of flights) {
          if (older < current) flight.controller.abort();
        }
        // Mark this generation before openSession: a throw can follow a partial UI change.
        selection = { generation: current, opened: false, acknowledged: false };
        try {
          openSession(granted.sessionId);
          selection.opened = true;
        } catch {
          return;
        }
      }
      const handoff = selection;
      if (handoff?.opened && !handoff.acknowledged) {
        handoff.acknowledged =
          (await invoke<SessionReceipt>(signal, "desktop_session_opened", generation)) ===
          "confirmed";
      }
    })().finally(() => {
      if (flights.get(current)?.controller === controller) flights.delete(current);
    });
    flights.set(current, { controller, done });
    return done;
  };

  const discard = (generation: string): void => {
    const current = parseGeneration(generation);
    if (current === undefined || current <= discarded) return;
    discarded = current;
    for (const [older, flight] of flights) {
      if (older <= discarded) flight.controller.abort();
    }
    if (selection && selection.generation <= discarded) selection = undefined;
  };

  const ready = async (): Promise<void> => {
    if (paused) return;
    readyCheck?.abort();
    const controller = new AbortController();
    readyCheck = controller;
    const { signal } = controller;
    try {
      const result = await invoke<SessionReply>(signal, "desktop_session_claim");
      if (signal.aborted || result === retry) return;
      if (result?.status === "wake") {
        await wake(result.generation);
      } else if (result?.status === "discard") {
        // Abort any grant already sent to this document before confirming discard.
        discard(result.generation);
        await invoke<SessionReceipt>(signal, "desktop_session_discarded", result.generation);
      }
    } finally {
      if (readyCheck === controller) readyCheck = undefined;
    }
  };

  const pause = () => {
    paused = true;
    readyCheck?.abort();
    readyCheck = undefined;
    for (const flight of flights.values()) flight.controller.abort();
    flights.clear();
  };
  const resume = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    paused = false;
    if (selection?.opened && !selection.acknowledged) void wake(String(selection.generation));
    if (urlGeneration) void wake(urlGeneration, true);
    void ready();
  };

  page.__codexhostOpenDesktopSession = wake;
  page.__codexhostRefreshDesktopSession = ready;
  page.addEventListener("pagehide", pause);
  page.addEventListener("pageshow", resume);
  return {
    wake,
    ready,
    readUrlGeneration: (generation: string) => {
      urlGeneration = generation;
    },
    dispose: () => {
      pause();
      page.removeEventListener("pagehide", pause);
      page.removeEventListener("pageshow", resume);
      if (page.__codexhostOpenDesktopSession === wake) delete page.__codexhostOpenDesktopSession;
      if (page.__codexhostRefreshDesktopSession === ready)
        delete page.__codexhostRefreshDesktopSession;
    },
  };
}
