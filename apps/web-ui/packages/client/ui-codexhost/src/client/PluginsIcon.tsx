import { IconPluginPinwheelOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { PLUGINS_PANEL_ID } from "./plugins-navigation.ts";

/** The single Plugins entry icon. */
export function PluginsIcon({ size }: Pick<SidebarPanelIconOwnerProps, "size">) {
  return <IconPluginPinwheelOutlineRegular size={size} />;
}

export interface PluginsActionFace {
  openPlugins: () => void;
}

/** Primary sidebar action that opens the Plugins workspace at the end of the navigation group. */
export function PluginsAction({
  size,
  renderAction,
  usePanelInfo,
  openPlugins,
  t,
}: PropsRuntime<"sidebar.primary.action"> & PropsLocale<"codexhostImport"> & PluginsActionFace) {
  const active = usePanelInfo((info) => info.activePanelId === PLUGINS_PANEL_ID);
  return renderAction({
    label: t("settings.extensions"),
    active,
    onClick: openPlugins,
    icon: <PluginsIcon size={size} />,
  });
}
