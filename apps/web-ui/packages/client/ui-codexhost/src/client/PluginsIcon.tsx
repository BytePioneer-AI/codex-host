import { useSyncExternalStore } from "react";
import { IconPluginPinwheelOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { PLUGINS_PANEL_ID, type PluginsNavigation } from "./plugins-navigation.ts";
import css from "./PluginsIcon.module.css";

/** The single Plugins entry icon, with an optional update indicator dot. */
export function PluginsIcon({
  size,
  updateAvailable = false,
}: Pick<SidebarPanelIconOwnerProps, "size"> & { updateAvailable?: boolean }) {
  return (
    <span className={css.icon} data-update-available={updateAvailable || undefined}>
      <IconPluginPinwheelOutlineRegular size={size} />
      {updateAvailable ? <span className={css.badge} aria-hidden="true" /> : null}
    </span>
  );
}

export interface PluginsActionFace {
  openPlugins: () => void;
  navigation: PluginsNavigation;
}

/** Primary sidebar action that opens the Plugins workspace at the end of the navigation group. */
export function PluginsAction({
  size,
  renderAction,
  usePanelInfo,
  openPlugins,
  navigation,
  t,
}: PropsRuntime<"sidebar.primary.action"> & PropsLocale<"codexhostImport"> & PluginsActionFace) {
  const active = usePanelInfo((info) => info.activePanelId === PLUGINS_PANEL_ID);
  const { hasUpdates } = useSyncExternalStore(
    navigation.store.subscribe,
    navigation.store.getSnapshot,
  );
  return renderAction({
    label: t("settings.extensions"),
    active,
    onClick: openPlugins,
    icon: <PluginsIcon size={size} updateAvailable={hasUpdates} />,
  });
}
