import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { PluginsIcon } from "./PluginsIcon.tsx";
import {
  WebExtensionsSection,
  type ContentLocalePreference,
  type WebExtensionsFace,
} from "./WebExtensionsSection.tsx";
import { ExtensionIcon } from "./WebExtensionCard.tsx";
import type { PluginsNavigation } from "./plugins-navigation.ts";
import {
  extensionPageIconUrl,
  extensionPageTitle,
  toExtensionLocale,
} from "./web-extensions-helpers.ts";
import css from "./PluginsSection.module.css";

export interface PluginsSectionFace extends Pick<WebExtensionsFace, "locale" | "colorScheme"> {
  navigation: PluginsNavigation;
}

const CONTENT_LOCALE_STORAGE_KEY = "codexhost.webExtensions.contentLocale";

function readContentLocalePreference(): ContentLocalePreference {
  try {
    const stored = localStorage.getItem(CONTENT_LOCALE_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Ignore restricted storage environments.
  }
  return "system";
}

/** The plugin center and standalone pages occupy the same main panel. */
export function PluginsSection({
  navigation,
  locale,
  colorScheme,
  t,
}: PropsLocale<"codexhostImport"> & PluginsSectionFace) {
  const { pages, selectedPage } = useSyncExternalStore(
    navigation.store.subscribe,
    navigation.store.getSnapshot,
  );
  const systemLocale = toExtensionLocale(useSyncExternalStore(locale.subscribe, locale.get));
  const [contentLocalePref, setContentLocalePref] = useState(readContentLocalePreference);
  const contentLocale = contentLocalePref === "system" ? systemLocale : contentLocalePref;
  const selectContentLocale = (next: ContentLocalePreference) => {
    setContentLocalePref(next);
    try {
      localStorage.setItem(CONTENT_LOCALE_STORAGE_KEY, next);
    } catch {
      // The preference still applies in this workspace when storage is restricted.
    }
  };

  const id = useId();
  const panelId = `${id}-panel`;
  const tabId = (pageId?: string) =>
    pageId === undefined ? `${id}-center` : `${id}-page-${pageId}`;
  const selectedTabId = tabId(selectedPage?.id);
  const activeTab = useRef<HTMLButtonElement>(null);
  const hasTabs = pages.length > 0;
  useEffect(() => {
    if (hasTabs) activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [hasTabs, selectedTabId]);

  const tabs = [null, ...pages];
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + tabs.length - 1) % tabs.length;
        break;
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(next)
      ?.focus({ preventScroll: true });
    navigation.selectPage(tabs[next] ?? null);
  };

  return (
    <div
      className={css.root}
      data-plugins-section
      data-standalone={selectedPage !== null || undefined}
    >
      {hasTabs && (
        <div className={css.tabList} role="tablist" aria-label={t("extensions.pageTabsLabel")}>
          {tabs.map((page, index) => {
            const selected = page?.id === selectedPage?.id;
            const title =
              page === null
                ? t("extensions.centerTab")
                : extensionPageTitle(page.manifest, contentLocale);
            return (
              <button
                key={tabId(page?.id)}
                id={tabId(page?.id)}
                ref={selected ? activeTab : undefined}
                type="button"
                className={css.tab}
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                title={title}
                onClick={() => navigation.selectPage(page)}
                onKeyDown={(event) => moveTab(event, index)}
              >
                <span className={css.tabIcon} aria-hidden="true">
                  {page === null ? (
                    <PluginsIcon size={16} />
                  ) : (
                    <ExtensionIcon src={extensionPageIconUrl(page)} size="sidebar" />
                  )}
                </span>
                <span className={css.tabLabel}>{title}</span>
              </button>
            );
          })}
        </div>
      )}
      <div
        className={css.panel}
        id={hasTabs ? panelId : undefined}
        role={hasTabs ? "tabpanel" : undefined}
        aria-labelledby={hasTabs ? selectedTabId : undefined}
        tabIndex={hasTabs ? 0 : undefined}
      >
        <WebExtensionsSection
          t={t}
          locale={locale}
          colorScheme={colorScheme}
          contentLocale={contentLocale}
          contentLocalePref={contentLocalePref}
          selectContentLocale={selectContentLocale}
          selectedPage={selectedPage}
          selectPage={navigation.selectPage}
        />
      </div>
    </div>
  );
}
