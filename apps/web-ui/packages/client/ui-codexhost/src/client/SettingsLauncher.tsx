import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { IconSettingsOutlineMedium, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { checkHostUpdate } from "./api.ts";
import css from "./SettingsLauncher.module.css";

export interface SettingsLauncherFace {
  connection: Pick<ConnectionHandle, "state">;
  openSection: (id: string) => void;
}

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
  useEffect(() => {
    if (!connected || settingsOpen) return;
    const controller = new AbortController();
    // Closing settings refreshes the badge after checks or installation on the update page.
    void checkHostUpdate(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]))
      .then((result) => {
        if (
          !controller.signal.aborted &&
          (result.error === null || result.latestVersion !== null)
        ) {
          setUpdateAvailable(result.updateAvailable);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [connected, settingsOpen]);

  const label = updateAvailable ? t("settings.updateAvailable") : t("settings.open");
  return (
    <Tooltip disabled={settingsOpen} label={label} shortcutKeys={settingsShortcut?.keys}>
      <button
        type="button"
        className={css.trigger}
        data-wide={wide}
        data-update-available={updateAvailable || undefined}
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
