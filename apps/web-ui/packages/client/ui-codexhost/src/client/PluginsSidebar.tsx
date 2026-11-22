import { useSyncExternalStore } from "react";
import {
  IconPluginPinwheelOutlineRegular,
  usePhoneSidebar,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SidebarPluginsOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { HostExtensionInstallation } from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { PLUGINS_PANEL_ID, type PluginsNavigation } from "./plugins-navigation.ts";
import {
  extensionPageIconUrl,
  extensionPageTitle,
  toExtensionLocale,
} from "./web-extensions-helpers.ts";
import { ExtensionIcon } from "./WebExtensionCard.tsx";

export interface PluginsSidebarFace {
  navigation: PluginsNavigation;
  locale: HostSettingsSource<string>;
}

export function PluginsSidebar({
  wide,
  renderGroup,
  usePanelInfo,
  t,
  navigation,
  locale,
}: SidebarPluginsOwnerProps &
  Pick<PropsRuntime<"sidebar.plugins">, "usePanelInfo"> &
  PropsLocale<"codexhostImport"> &
  PluginsSidebarFace) {
  const { pages, selectedPage } = useSyncExternalStore(
    navigation.store.subscribe,
    navigation.store.getSnapshot,
  );
  const active = usePanelInfo((info) => info.activePanelId === PLUGINS_PANEL_ID);
  const language = toExtensionLocale(useSyncExternalStore(locale.subscribe, locale.get));
  const drawer = usePhoneSidebar();
  const open = (page: HostExtensionInstallation | null) => {
    navigation.open(page);
    drawer?.close();
  };

  const group = t("settings.extensions");
  const center = {
    id: PLUGINS_PANEL_ID,
    label: wide ? t("extensions.center") : group,
    icon: <IconPluginPinwheelOutlineRegular size={wide ? 16 : 18} />,
    active: active && (!wide || selectedPage === null),
    onClick: () => open(null),
  };
  return renderGroup({
    label: group,
    rows: wide
      ? [
          center,
          ...pages.map((page) => ({
            id: `page:${page.id}`,
            label: extensionPageTitle(page.manifest, language),
            icon: <ExtensionIcon src={extensionPageIconUrl(page)} size="sidebar" />,
            active: active && selectedPage?.id === page.id,
            onClick: () => open(page),
          })),
        ]
      : [center],
  });
}
