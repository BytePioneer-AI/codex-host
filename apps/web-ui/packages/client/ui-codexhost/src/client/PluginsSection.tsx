import { useSyncExternalStore, type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { WebExtensionsSection, type WebExtensionsFace } from "./WebExtensionsSection.tsx";
import type { PluginsNavigation } from "./plugins-navigation.ts";
import css from "./PluginsSection.module.css";

export interface PluginsSectionFace extends Pick<WebExtensionsFace, "locale" | "colorScheme"> {
  navigation: PluginsNavigation;
}

/** The plugin center and standalone pages occupy the same main panel. */
export function PluginsSection({
  navigation,
  ...props
}: PropsLocale<"codexhostImport"> & PluginsSectionFace): ReactNode {
  const { selectedPage } = useSyncExternalStore(
    navigation.store.subscribe,
    navigation.store.getSnapshot,
  );
  return (
    <div
      className={css.root}
      data-plugins-section
      data-standalone={selectedPage !== null || undefined}
    >
      <WebExtensionsSection
        {...props}
        selectedPage={selectedPage}
        selectPage={navigation.selectPage}
      />
    </div>
  );
}
