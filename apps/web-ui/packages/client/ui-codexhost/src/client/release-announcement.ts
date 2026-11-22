import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { acknowledgeReleaseAnnouncement, getReleaseAnnouncement } from "./api.ts";
import {
  loadHostSettings,
  type HostSettingsSource,
  type WebReleaseAnnouncementControl,
} from "./HostSettingsSection.tsx";

const ANNOUNCEMENT_REQUEST_TIMEOUT_MS = 20_000;

export interface WatchReleaseAnnouncementOptions {
  readonly connection: Pick<ConnectionHandle, "state">;
  readonly locale: HostSettingsSource<string>;
  readonly colorScheme: HostSettingsSource<"light" | "dark">;
}

/**
 * Checks once per Web page lifecycle after connecting to the Host and opens
 * the shared release announcement dialog when the running version is unread.
 */
export function watchReleaseAnnouncement({
  connection,
  locale,
  colorScheme,
}: WatchReleaseAnnouncementOptions): () => void {
  let stopped = false;
  let checked = false;
  let request: AbortController | null = null;
  let activeDialog: WebReleaseAnnouncementControl | null = null;
  let unsubscribeTheme: (() => void) | null = null;

  const stopThemeSync = (): void => {
    unsubscribeTheme?.();
    unsubscribeTheme = null;
  };

  const checkOnce = (): void => {
    if (stopped || checked || connection.state.getSnapshot() !== "connected") return;
    checked = true;
    const controller = new AbortController();
    request = controller;
    void getReleaseAnnouncement(
      AbortSignal.any([controller.signal, AbortSignal.timeout(ANNOUNCEMENT_REQUEST_TIMEOUT_MS)]),
    )
      .then(async (result) => {
        if (stopped || controller.signal.aborted || !result.unread || !result.announcement) return;
        const pages = await loadHostSettings();
        if (stopped || controller.signal.aborted || !pages.openReleaseAnnouncement) return;
        const { announcement } = result;
        activeDialog = pages.openReleaseAnnouncement(announcement, {
          locale: locale.get(),
          colorScheme: colorScheme.get(),
          onClose() {
            activeDialog = null;
            stopThemeSync();
            void acknowledgeReleaseAnnouncement(announcement.version).catch(() => undefined);
          },
        });
        if (activeDialog) {
          unsubscribeTheme = colorScheme.subscribe(() => {
            activeDialog?.setColorScheme(colorScheme.get());
          });
        }
      })
      .catch(() => {
        // Missing RPC, offline state, or script failure stays silent and unacknowledged.
      })
      .finally(() => {
        if (request === controller) request = null;
      });
  };

  const unsubscribeConnection = connection.state.subscribe(checkOnce);
  checkOnce();

  return () => {
    stopped = true;
    unsubscribeConnection();
    stopThemeSync();
    request?.abort();
    request = null;
    activeDialog?.dispose();
    activeDialog = null;
  };
}
