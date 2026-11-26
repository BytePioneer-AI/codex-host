export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __CODEXHOST_DESKTOP_SHELL__?: boolean }).__CODEXHOST_DESKTOP_SHELL__ === true
  );
}

type SessionPage = Window & {
  __TAURI_INTERNALS__?: {
    invoke(command: string, args: { generation: string; document: string }): Promise<unknown>;
  };
  __codexhostOpenDesktopSession?: (generation: string) => Promise<void>;
};

export const desktopSessionGenerationQuery = "desktopSessionGeneration";

export function attachDesktopSessionPage(openSession: (sessionId: string) => void) {
  const page: SessionPage = window;
  const document = crypto.randomUUID();
  let latest = 0n;
  let attempted = false;
  let opened = false;
  const wake = async (generation: string): Promise<void> => {
    if (!/^\d{1,20}$/.test(generation)) return;
    const current = BigInt(generation);
    if (current < latest) return;
    if (current > latest) {
      latest = current;
      attempted = opened = false;
    }
    const args = { generation, document };
    try {
      if (!attempted) {
        const sessionId = await page.__TAURI_INTERNALS__?.invoke("desktop_session_claim", args);
        if (
          page.__codexhostOpenDesktopSession !== wake ||
          current !== latest ||
          typeof sessionId !== "string"
        )
          return;
        if (!attempted) {
          // If opening throws after changing workspace state, a probe must not open it again.
          attempted = true;
          openSession(sessionId);
          opened = true;
        }
      }
      if (opened) await page.__TAURI_INTERNALS__?.invoke("desktop_session_opened", args);
    } catch {
      // No receipt: the shell can probe this document or retry on Web reconnect.
    }
  };
  page.__codexhostOpenDesktopSession = wake;
  return {
    wake,
    dispose: () => {
      if (page.__codexhostOpenDesktopSession === wake) delete page.__codexhostOpenDesktopSession;
    },
  };
}
