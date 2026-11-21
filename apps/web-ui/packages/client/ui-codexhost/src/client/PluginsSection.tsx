/**
 * Unified Plugins settings section backed by the shared Host extension manager.
 * Manages all Desktop, Web, standalone `page`, and Node backend plugins in a single surface.
 */
import type { ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { WebExtensionsSection } from "./WebExtensionsSection.tsx";
import css from "./PluginsSection.module.css";

export interface PluginsSectionFace {
  locale: HostSettingsSource<string>;
  colorScheme: HostSettingsSource<"light" | "dark">;
}

export function PluginsSection({
  t,
  locale,
  colorScheme,
}: PropsLocale<"codexhostImport"> & PluginsSectionFace): ReactNode {
  return (
    <div className={css.root} data-plugins-section>
      <WebExtensionsSection t={t} locale={locale} colorScheme={colorScheme} />
    </div>
  );
}
