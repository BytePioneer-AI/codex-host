import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { IconSettingsOutlineMedium, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { checkHostUpdate } from "./api.ts";
import { preloadHostSettings } from "./HostSettingsSection.tsx";
import css from "./SettingsLauncher.module.css";

export interface SettingsLauncherFace {
  connection: Pick<ConnectionHandle, "state">;
  openSection: (id: string) => void;
}

const UPDATE_REFRESH_INTERVAL_MS = 15 * 60_000;

export function SettingsLauncher({
  wide,
  settingsOpen,
  settingsShortcut,
  openSettings,
  connection,
  openSection,
  t,
}: PropsRuntime<"settings.launcher"> & PropsLocale<"codexhostImport"> & SettingsLauncherFace) {
  const connected =
    useSyncExternalStore(connection.state.subscribe, connection.state.getSnapshot) === "connected";
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  useEffect(() => {
    if (settingsOpen) preloadHostSettings();
  }, [settingsOpen]);
  useEffect(() => {
    if (!connected || settingsOpen) return;
    let activeController: AbortController | null = null;
    const refresh = (): void => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      // Closing settings or periodic polling refreshes the badge as background staging completes.
      void checkHostUpdate(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
        .then((result) => {
          if (
            !controller.signal.aborted &&
            (result.error === null || result.latestVersion !== null)
          ) {
            const available =
              result.updateAvailable &&
              (result.installationAvailable ||
                result.error !== null ||
                result.backgroundPhase === "failed");
            const staged =
              available &&
              result.stagedVersion &&
              result.stagedVersion === result.latestVersion &&
              result.backgroundPhase === "ready"
                ? result.stagedVersion
                : null;
            setUpdateAvailable(available);
            setReadyVersion(staged);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh();
    }, UPDATE_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      activeController?.abort();
    };
  }, [connected, settingsOpen]);

  const label = readyVersion
    ? t("settings.updateReady", { version: readyVersion })
    : updateAvailable
      ? t("settings.updateAvailable")
      : t("settings.open");
  return (
    <Tooltip disabled={settingsOpen} label={label} shortcutKeys={settingsShortcut?.keys}>
      <button
        type="button"
        className={css.trigger}
        data-wide={wide}
        data-update-available={updateAvailable || undefined}
        data-update-ready={readyVersion ? "true" : undefined}
        aria-label={label}
        aria-keyshortcuts={settingsShortcut?.aria}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => {
          if (updateAvailable) openSection("codexhost-updates");
          else openSettings();
        }}
      >
        <span className={css.icon}>
          <IconSettingsOutlineMedium size={wide ? 16 : 18} />
          {updateAvailable ? <span className={css.badge} aria-hidden="true" /> : null}
        </span>
        {wide ? <span className={css.label}>{t("settings.open")}</span> : null}
      </button>
    </Tooltip>
  );
}
