/**
 * Unified Plugins settings section: defaults to Web plugins and silently probes whether the
 * connected Host supports Desktop extension management. When supported, reveals a lightweight
 * Web | Desktop switcher in the section header without introducing duplicate headings.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WebUiExtensionMeta } from "@codexhost/shared-contracts";
import { probeDesktopExtensionsSupport } from "./api.ts";
import { HostSettingsSection, type HostSettingsSource } from "./HostSettingsSection.tsx";
import { WebExtensionsSection } from "./WebExtensionsSection.tsx";
import css from "./PluginsSection.module.css";

type PluginsTarget = "web" | "desktop";

export interface PluginsSectionFace {
  resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string;
  locale: HostSettingsSource<string>;
  colorScheme: HostSettingsSource<"light" | "dark">;
}

/**
 * Injected into the embedded Desktop extensions Shadow DOM so the outer shell owns the section
 * heading and target switcher, while keeping the Desktop toolbar, menus, and mobile layout clean.
 */
const EMBEDDED_DESKTOP_EXTENSIONS_CSS = `
.settings-extensions__header {
  position: relative;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px 12px;
  margin-bottom: 0;
}

.settings-extensions__header-left > .settings-section-label {
  display: none;
}

.settings-extensions__header-left:not(:has(.settings-extensions__connection:not([hidden]))) {
  display: none;
}

.settings-extensions__header-left {
  order: 2;
}

.settings-extensions__header .settings-remote__toolbar {
  order: 1;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-extensions__locale .settings-extensions-menu {
  left: 0;
  right: auto;
}

@container codexhost-settings-page (max-width: 540px) {
  .settings-extensions__header .settings-remote__toolbar {
    width: 100%;
  }

  .settings-extensions-menu {
    max-width: calc(100cqi - 8px);
  }
}

@media (max-width: 640px) {
  .settings-extensions__header .settings-remote__toolbar {
    width: 100%;
  }

  .settings-extensions__header .settings-command-button,
  .settings-extensions__header .settings-icon-button {
    min-height: 32px;
  }

  .settings-extensions__more {
    position: static;
  }

  .settings-extensions__more .settings-extensions-menu {
    top: calc(100% + 4px);
    right: 0;
    left: auto;
    max-width: calc(100vw - 32px);
  }

  .settings-extensions__toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .settings-extensions-segmented {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }

  .settings-extensions__search {
    flex: 1 1 auto;
    width: 100%;
    margin-left: 0;
  }
}
`;

export function PluginsSection({
  t,
  resolveText,
  locale,
  colorScheme,
}: PropsLocale<"codexhostImport"> & PluginsSectionFace): ReactNode {
  const [desktopSupported, setDesktopSupported] = useState(false);
  const [activeTarget, setActiveTarget] = useState<PluginsTarget>("web");

  useEffect(() => {
    const controller = new AbortController();
    void probeDesktopExtensionsSupport(controller.signal).then((supported) => {
      if (!controller.signal.aborted && supported) {
        setDesktopSupported(true);
      }
    });
    return () => controller.abort();
  }, []);

  const targetSwitcher = desktopSupported ? (
    <div
      className={css.targetSwitcher}
      role="group"
      aria-label={t("extensions.targetSwitcherLabel")}
      data-plugins-target-switcher
    >
      <button
        type="button"
        className={css.targetOption}
        aria-pressed={activeTarget === "web"}
        data-target="web"
        onClick={() => setActiveTarget("web")}
      >
        {t("extensions.targetWeb")}
      </button>
      <button
        type="button"
        className={css.targetOption}
        aria-pressed={activeTarget === "desktop"}
        data-target="desktop"
        onClick={() => setActiveTarget("desktop")}
      >
        {t("extensions.targetDesktop")}
      </button>
    </div>
  ) : null;

  return (
    <div className={css.root} data-plugins-section data-plugins-target={activeTarget}>
      {/* Keep Web plugins mounted while viewing Desktop so returning preserves tabs, search, and cache. */}
      <div className={css.pane} hidden={activeTarget !== "web"}>
        <WebExtensionsSection
          t={t}
          resolveText={resolveText}
          locale={locale}
          headerAccessory={targetSwitcher}
        />
      </div>

      {desktopSupported && activeTarget === "desktop" ? (
        <div className={css.desktopPane} data-desktop-plugins>
          <header className={css.desktopHeader}>
            <div className={css.desktopHeaderLeft}>
              <h2 className={css.title}>{t("settings.extensions")}</h2>
              {targetSwitcher}
            </div>
          </header>

          <HostSettingsSection
            t={t}
            pageId="desktop-extensions"
            locale={locale}
            colorScheme={colorScheme}
            shadowCss={EMBEDDED_DESKTOP_EXTENSIONS_CSS}
          />
        </div>
      ) : null}
    </div>
  );
}
