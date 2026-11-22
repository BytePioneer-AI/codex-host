import { IconPluginPinwheelOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";

/** The single Plugins entry in the sidebar panel list. */
export function PluginsIcon({ size }: Pick<SidebarPanelIconOwnerProps, "size">) {
  return <IconPluginPinwheelOutlineRegular size={size} />;
}
