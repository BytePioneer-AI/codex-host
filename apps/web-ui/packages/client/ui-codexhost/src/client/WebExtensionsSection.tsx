/** Web settings section for managing installed (`codexhost` & `dsh`) extensions and the Marketplace. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGlobeOutlineRegular,
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSparkleRegular,
  Switch,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  resolveLocalizedExtensionText,
  type DesktopExtensionCategory,
  type ExtensionCatalogV2Entry,
  type WebExtensionList,
  type WebNativeExtensionListItem,
  type WebUiExtension,
  type WebUiExtensionMeta,
} from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { formatWebExtensionError } from "./web-extension-errors.ts";
import {
  isWebExtensionAuthDisabledError,
  isWebExtensionStaleError,
  webNativeExtensionsApi,
} from "./web-native-extension-management-api.ts";
import {
  CATEGORY_ORDER,
  categoryLabelForLocale,
  dshText,
  extensionKey,
  formatManagementError,
  hasNativeCatalogUpdate,
  isCatalogEntryWebCompatible,
  isNativeExtension,
  isNativeToggleBlocked,
  itemGroupOf,
  matchesCatalogSearch,
  matchesInstalledSearch,
  nativeDescription,
  nativeDisplayName,
  resolveNativeIconUrl,
  resolveOptionalLocalizedText,
  toExtensionLocale,
  type ExtensionGroupId,
  type ExtensionLocale,
  type WebExtensionItem,
} from "./web-extensions-helpers.ts";
import { InstalledCheckIcon, WebExtensionCard } from "./WebExtensionCard.tsx";
import { WebExtensionDetailModal, type DetailModalTarget } from "./WebExtensionDetailModal.tsx";
import {
  InstallWebExtensionDialog,
  type InstallWebExtensionRequest,
} from "./InstallWebExtensionDialog.tsx";
import { CreateWebExtensionDialog } from "./CreateWebExtensionDialog.tsx";
import css from "./WebExtensionsSection.module.css";

type ActiveTab = "installed" | "market";
type ContentLocalePreference = "system" | ExtensionLocale;

type ListView =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: WebExtensionList }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly message: string };

interface MarketState {
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly entries: readonly ExtensionCatalogV2Entry[];
  readonly stale: boolean;
  readonly error: string | null;
}

type SelectedRef =
  | { readonly kind: "installed"; readonly format: "codexhost" | "dsh"; readonly id: string }
  | { readonly kind: "market"; readonly id: string };

type Feedback = { readonly tone: "success" | "warning" | "danger"; readonly text: string };

export interface WebExtensionsFace {
  resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string;
  locale: HostSettingsSource<string>;
  headerAccessory?: ReactNode;
}

const GROUP_ORDER: readonly ExtensionGroupId[] = ["attention", "enabled", "disabled"];
const CONTENT_LOCALE_STORAGE_KEY = "codexhost.webExtensions.contentLocale";

const INITIAL_MARKET: MarketState = {
  loading: false,
  loaded: false,
  entries: [],
  stale: false,
  error: null,
};

function readContentLocalePreference(): ContentLocalePreference {
  try {
    const stored =
      typeof localStorage !== "undefined" ? localStorage.getItem(CONTENT_LOCALE_STORAGE_KEY) : null;
    if (stored === "system" || stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Ignore restricted storage environments.
  }
  return "system";
}

function writeContentLocalePreference(preference: ContentLocalePreference): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CONTENT_LOCALE_STORAGE_KEY, preference);
    }
  } catch {
    // Ignore restricted storage environments.
  }
}

function UploadArrowIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/** Settings section for Web native (`codexhost`) and legacy (`dsh`) extensions + Marketplace. */
export function WebExtensionsSection({
  t,
  resolveText,
  locale,
  headerAccessory,
}: PropsLocale<"codexhostImport"> & WebExtensionsFace): ReactNode {
  const activeLocaleRaw = useSyncExternalStore(locale.subscribe, locale.get);
  const systemLocale = toExtensionLocale(activeLocaleRaw);
  const [contentLocalePref, setContentLocalePref] = useState<ContentLocalePreference>(() =>
    readContentLocalePreference(),
  );
  const contentLocale: ExtensionLocale =
    contentLocalePref === "system" ? systemLocale : contentLocalePref;

  const [listView, setListView] = useState<ListView>({ kind: "loading" });
  const [market, setMarket] = useState<MarketState>(INITIAL_MARKET);
  const [activeTab, setActiveTab] = useState<ActiveTab>("installed");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<DesktopExtensionCategory | null>(null);

  const [localeMenuOpen, setLocaleMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null);

  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [modalFeedback, setModalFeedback] = useState<Feedback | null>(null);

  const localeWrapRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dismiss dropdown menus on outside pointerdown or Escape.
  useEffect(() => {
    if (!localeMenuOpen && !moreMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (localeMenuOpen && localeWrapRef.current && !localeWrapRef.current.contains(target)) {
        setLocaleMenuOpen(false);
      }
      if (moreMenuOpen && moreWrapRef.current && !moreWrapRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLocaleMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [localeMenuOpen, moreMenuOpen]);

  const selectContentLocale = (next: ContentLocalePreference) => {
    setContentLocalePref(next);
    writeContentLocalePreference(next);
    setLocaleMenuOpen(false);
  };

  const refreshList = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const data = await webNativeExtensionsApi.list(signal);
        if (signal?.aborted || !mountedRef.current) return;
        setListView({ kind: "ready", data });
      } catch (cause: unknown) {
        if (signal?.aborted || !mountedRef.current) return;
        if (isWebExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
        } else {
          setListView({ kind: "failed", message: formatManagementError(cause, t) });
        }
      }
    },
    [t],
  );

  const refreshMarket = async (): Promise<void> => {
    setMarket((prev) => ({ ...prev, loading: true }));
    try {
      const result = await webNativeExtensionsApi.marketRefresh();
      if (!mountedRef.current) return;
      const webEntries = result.extensions.filter((entry) => entry.targets.includes("web"));
      setMarket({
        loading: false,
        loaded: true,
        entries: webEntries,
        stale: result.stale,
        error: result.error ?? null,
      });
    } catch (cause: unknown) {
      if (!mountedRef.current) return;
      if (isWebExtensionAuthDisabledError(cause)) {
        setListView({ kind: "disabled" });
        setMarket((prev) => ({ ...prev, loading: false }));
        return;
      }
      setMarket((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        stale: prev.entries.length > 0,
        error: formatManagementError(cause, t),
      }));
    }
  };

  const openMarket = () => {
    setActiveTab("market");
    setSelectedCategory(null);
    if (!market.loaded && !market.loading) void refreshMarket();
  };

  useEffect(() => {
    const controller = new AbortController();
    void refreshList(controller.signal);
    return () => controller.abort();
  }, [refreshList]);

  const runMutation = useCallback(
    async (
      actionKey: string,
      operation: () => Promise<WebExtensionList>,
      options?: {
        readonly successText?: string;
        readonly target?: "page" | "modal" | "install";
        readonly onSuccess?: (list: WebExtensionList) => void;
      },
    ): Promise<boolean> => {
      if (runningRef.current) return false;
      runningRef.current = true;
      setActiveAction(actionKey);
      const target = options?.target ?? "page";
      if (target === "install") setInstallError(null);
      else if (target === "modal") setModalFeedback(null);
      else setFeedback(null);

      try {
        const nextList = await operation();
        if (!mountedRef.current) return true;
        setListView({ kind: "ready", data: nextList });
        if (options?.successText) {
          const msg: Feedback = { tone: "success", text: options.successText };
          if (target === "modal") setModalFeedback(msg);
          else setFeedback(msg);
        }
        options?.onSuccess?.(nextList);
        return true;
      } catch (cause: unknown) {
        if (!mountedRef.current) return false;
        if (isWebExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
          setInstallOpen(false);
          setSelectedRef(null);
          return false;
        }
        const message = formatManagementError(cause, t);
        if (isWebExtensionStaleError(cause)) {
          void refreshList();
        }
        if (target === "install") {
          setInstallError(t("extensions.actionFailed", { message }));
        } else if (target === "modal") {
          setModalFeedback({ tone: "danger", text: t("extensions.actionFailed", { message }) });
        } else {
          setFeedback({ tone: "danger", text: t("extensions.actionFailed", { message }) });
        }
        return false;
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setActiveAction(null);
      }
    },
    [refreshList, t],
  );

  const extensions = listView.kind === "ready" ? listView.data.extensions : [];
  const dshLoadedIds = listView.kind === "ready" ? listView.data.dshLoadedIds : [];
  const safeMode = listView.kind === "ready" ? listView.data.safeMode : false;
  const storeError = listView.kind === "ready" ? listView.data.storeError : undefined;

  const nativeById = useMemo(() => {
    const map = new Map<string, WebNativeExtensionListItem>();
    for (const item of extensions) {
      if (isNativeExtension(item)) map.set(item.id, item);
    }
    return map;
  }, [extensions]);

  const dshById = useMemo(() => {
    const map = new Map<string, WebUiExtension>();
    for (const item of extensions) {
      if (!isNativeExtension(item)) map.set(item.id, item);
    }
    return map;
  }, [extensions]);

  const catalogById = useMemo(() => {
    const map = new Map<string, ExtensionCatalogV2Entry>();
    for (const entry of market.entries) {
      map.set(entry.id, entry);
    }
    return map;
  }, [market.entries]);

  const availableCategories = useMemo(() => {
    const present = new Set<DesktopExtensionCategory>();
    if (activeTab === "installed") {
      for (const item of extensions) {
        if (isNativeExtension(item)) {
          for (const cat of item.manifest?.categories ?? []) present.add(cat);
        }
      }
    } else {
      for (const entry of market.entries) {
        for (const cat of entry.categories ?? []) present.add(cat);
      }
    }
    return CATEGORY_ORDER.filter((cat) => present.has(cat));
  }, [activeTab, extensions, market.entries]);

  useEffect(() => {
    if (selectedCategory !== null && !availableCategories.includes(selectedCategory)) {
      setSelectedCategory(null);
    }
  }, [availableCategories, selectedCategory]);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredInstalled = useMemo(() => {
    return extensions.filter((item) => {
      if (selectedCategory !== null) {
        if (!isNativeExtension(item)) return false;
        if (!item.manifest?.categories?.includes(selectedCategory)) return false;
      }
      return matchesInstalledSearch(item, normalizedQuery, resolveText, t);
    });
  }, [extensions, selectedCategory, normalizedQuery, resolveText, t]);

  const groupedInstalled = useMemo(() => {
    const buckets: Record<ExtensionGroupId, WebExtensionItem[]> = {
      attention: [],
      enabled: [],
      disabled: [],
    };
    for (const item of filteredInstalled) {
      buckets[itemGroupOf(item, dshLoadedIds, safeMode)].push(item);
    }
    return GROUP_ORDER.filter((group) => buckets[group].length > 0).map((group) => ({
      id: group,
      items: buckets[group],
    }));
  }, [filteredInstalled, dshLoadedIds, safeMode]);

  const filteredMarket = useMemo(() => {
    return market.entries.filter((entry) => {
      if (selectedCategory !== null && !entry.categories?.includes(selectedCategory)) {
        return false;
      }
      return matchesCatalogSearch(entry, normalizedQuery, t);
    });
  }, [market.entries, selectedCategory, normalizedQuery, t]);

  const detailTarget: DetailModalTarget | null = useMemo(() => {
    if (selectedRef === null) return null;
    if (selectedRef.kind === "installed" && selectedRef.format === "dsh") {
      const item = dshById.get(selectedRef.id);
      return item ? { kind: "dsh", item } : null;
    }
    const nativeItem = nativeById.get(selectedRef.id);
    const catalog = catalogById.get(selectedRef.id);
    if (!nativeItem && !catalog) return null;
    return { kind: "native", item: nativeItem, catalog };
  }, [selectedRef, dshById, nativeById, catalogById]);

  const busy = activeAction !== null;

  const handleToggleNative = (
    item: WebNativeExtensionListItem,
    enabled: boolean,
    fromModal: boolean,
  ) => {
    const name = nativeDisplayName(item, contentLocale, catalogById.get(item.id));
    void runMutation(
      `toggle:codexhost:${item.id}`,
      () => webNativeExtensionsApi.setEnabled({ format: "codexhost", id: item.id, enabled }),
      {
        target: fromModal ? "modal" : "page",
        successText: t(enabled ? "extensions.savedEnabled" : "extensions.savedDisabled", { name }),
      },
    );
  };

  const handleToggleDsh = (item: WebUiExtension, enabled: boolean, fromModal: boolean) => {
    const { title } = dshText(item, resolveText);
    void runMutation(
      `toggle:dsh:${item.id}`,
      () => webNativeExtensionsApi.setEnabled({ format: "dsh", id: item.id, enabled }),
      {
        target: fromModal ? "modal" : "page",
        successText: t(enabled ? "extensions.savedEnabled" : "extensions.savedDisabled", {
          name: title,
        }),
      },
    );
  };

  const handleInstallMarket = (entry: ExtensionCatalogV2Entry, fromModal: boolean) => {
    const name = resolveLocalizedExtensionText(entry.name, contentLocale);
    void runMutation(
      `install:${entry.id}`,
      () =>
        webNativeExtensionsApi.install({
          format: "codexhost",
          source: {
            type: "market",
            id: entry.id,
            version: entry.version,
            sha256: entry.sha256,
          },
        }),
      {
        target: fromModal ? "modal" : "page",
        successText: t("extensions.installedSuccess", { name }),
      },
    );
  };

  const handleUpdateNative = (
    item: WebNativeExtensionListItem,
    entry: ExtensionCatalogV2Entry,
    fromModal: boolean,
  ) => {
    const expectedDigest = item.digest;
    if (!expectedDigest) return;
    const name = nativeDisplayName(item, contentLocale, entry);
    void runMutation(
      `update:${item.id}`,
      () =>
        webNativeExtensionsApi.update({
          format: "codexhost",
          id: item.id,
          expectedDigest,
          source: {
            type: "market",
            id: entry.id,
            version: entry.version,
            sha256: entry.sha256,
          },
        }),
      {
        target: fromModal ? "modal" : "page",
        successText: t("extensions.updatedSuccess", {
          name,
          version: entry.version.replace(/^v/u, ""),
        }),
      },
    );
  };

  const handleUninstallNative = (item: WebNativeExtensionListItem) => {
    const name = nativeDisplayName(item, contentLocale, catalogById.get(item.id));
    const hasCatalog = catalogById.has(item.id);
    void runMutation(
      `uninstall:codexhost:${item.id}`,
      () => webNativeExtensionsApi.uninstall({ format: "codexhost", id: item.id }),
      {
        target: "page",
        successText: t("extensions.uninstalledSuccess", { name }),
        onSuccess: () => {
          if (!hasCatalog) setSelectedRef(null);
          setModalFeedback(null);
        },
      },
    );
  };

  const handleUninstallDsh = (item: WebUiExtension) => {
    const { title } = dshText(item, resolveText);
    void runMutation(
      `uninstall:dsh:${item.id}`,
      () => webNativeExtensionsApi.uninstall({ format: "dsh", id: item.id }),
      {
        target: "page",
        successText: t("extensions.uninstalledSuccess", { name: title }),
        onSuccess: () => {
          setSelectedRef(null);
          setModalFeedback(null);
        },
      },
    );
  };

  const handleManualInstall = (request: InstallWebExtensionRequest): Promise<boolean> => {
    if (request.format === "codexhost" && request.kind === "zip") {
      return runMutation(
        "install:manual",
        () => webNativeExtensionsApi.installNativeZip(request.file),
        {
          target: "install",
          successText: t("extensions.installedSuccess", { name: request.file.name }),
          onSuccess: () => {
            setInstallOpen(false);
            setActiveTab("installed");
          },
        },
      );
    }
    if (request.format === "codexhost" && request.kind === "github") {
      return runMutation(
        "install:manual",
        () =>
          webNativeExtensionsApi.install({
            format: "codexhost",
            source: {
              type: "github",
              repository: request.repository,
              ...(request.tag !== undefined ? { tag: request.tag } : {}),
              asset: request.asset,
            },
          }),
        {
          target: "install",
          successText: t("extensions.installedSuccess", { name: request.repository }),
          onSuccess: () => {
            setInstallOpen(false);
            setActiveTab("installed");
          },
        },
      );
    }
    return runMutation(
      "install:manual",
      () =>
        webNativeExtensionsApi.install({
          format: "dsh",
          source: { spec: request.spec, registry: request.registry },
        }),
      {
        target: "install",
        successText: t("extensions.installedSuccess", { name: request.spec }),
        onSuccess: () => {
          setInstallOpen(false);
          setActiveTab("installed");
        },
      },
    );
  };

  const handleRefreshAll = () => {
    if (busy) return;
    setFeedback(null);
    void refreshList();
    void refreshMarket();
  };

  const renderHeader = (options: { readonly canMutate: boolean }) => (
    <header className={css.header}>
      <div className={css.headerLeft}>
        <h2 className={css.title}>{t("settings.extensions")}</h2>
        {headerAccessory}
      </div>

      <div className={css.toolbar}>
        {/* Content language switcher (matching Desktop EN / 中文 dropdown) */}
        <div ref={localeWrapRef} className={css.menuAnchor}>
          <button
            type="button"
            className={css.toolbarButton}
            data-action="content-locale-menu"
            aria-label={t("extensions.contentLocaleLabel")}
            title={t("extensions.contentLocaleLabel")}
            aria-haspopup="menu"
            aria-expanded={localeMenuOpen}
            disabled={busy}
            onClick={() => {
              setMoreMenuOpen(false);
              setLocaleMenuOpen((open) => !open);
            }}
          >
            <IconGlobeOutlineRegular size={13} />
            <span className={css.localeLabel}>{contentLocale === "zh-CN" ? "中文" : "EN"}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>

          {localeMenuOpen && (
            <div
              className={`${css.menu} ${css.menuCompact}`}
              role="menu"
              aria-label={t("extensions.contentLocaleLabel")}
            >
              {(
                [
                  ["system", t("extensions.contentLocaleFollowSystem")],
                  ["zh-CN", t("extensions.contentLocaleZh")],
                  ["en", t("extensions.contentLocaleEn")],
                ] as const
              ).map(([value, label]) => {
                const selected = contentLocalePref === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`${css.menuItem} ${css.menuItemRadio}`}
                    onClick={() => selectContentLocale(value)}
                  >
                    <span>{label}</span>
                    {selected && (
                      <span className={css.menuCheck} aria-hidden="true">
                        <IconCheckOutlineRegular size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Create plugin button (light outline matching Desktop) */}
        <button
          type="button"
          className={css.toolbarButton}
          data-action="open-create"
          disabled={busy}
          onClick={() => {
            setLocaleMenuOpen(false);
            setMoreMenuOpen(false);
            setCreateOpen(true);
          }}
        >
          <IconSparkleRegular size={13} />
          <span>{t("extensions.create.button")}</span>
        </button>

        {/* Import plugin button (light outline matching Desktop) */}
        <button
          type="button"
          className={css.toolbarButton}
          data-action="open-import"
          disabled={busy || !options.canMutate}
          onClick={() => {
            setLocaleMenuOpen(false);
            setMoreMenuOpen(false);
            setInstallError(null);
            setInstallOpen(true);
          }}
        >
          <UploadArrowIcon />
          <span>{t("extensions.add")}</span>
        </button>

        {/* Refresh icon button */}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t("extensions.refresh")}
          title={t("extensions.refresh")}
          disabled={busy || market.loading}
          aria-busy={market.loading}
          onClick={handleRefreshAll}
        >
          <IconRefreshOutlineRegular size={15} />
        </button>

        {/* More ("...") menu containing recovery actions */}
        <div ref={moreWrapRef} className={`${css.menuAnchor} ${css.moreMenuAnchor}`}>
          <button
            type="button"
            className={css.iconButton}
            data-action="more-menu"
            aria-label={t("extensions.moreActions")}
            title={t("extensions.moreActions")}
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            disabled={busy}
            onClick={() => {
              setLocaleMenuOpen(false);
              setMoreMenuOpen((open) => !open);
            }}
          >
            <IconEllipsisOutlineRegular size={16} />
          </button>

          {moreMenuOpen && (
            <div className={css.menu} role="menu" aria-label={t("extensions.moreActions")}>
              <a
                className={css.menuItem}
                role="menuitem"
                href="/extensions"
                onClick={() => setMoreMenuOpen(false)}
              >
                {t("extensions.recovery")}
              </a>
              <a
                className={css.menuItem}
                role="menuitem"
                href="/?extensions=off"
                onClick={() => setMoreMenuOpen(false)}
              >
                {t("extensions.builtinsOnly")}
              </a>
            </div>
          )}
        </div>
      </div>
    </header>
  );

  if (listView.kind === "loading") {
    return (
      <div className={css.page} data-web-extensions>
        {renderHeader({ canMutate: false })}
        <p className={css.hint}>{t("extensions.loading")}</p>
      </div>
    );
  }

  if (listView.kind === "disabled") {
    return (
      <div className={css.page} data-web-extensions>
        {renderHeader({ canMutate: false })}
        <div className={css.emptyCard} data-web-extensions-notice="disabled">
          <div className={css.emptyCopy}>
            <p className={css.emptyDesc}>{t("extensions.authDisabled")}</p>
          </div>
        </div>
      </div>
    );
  }

  if (listView.kind === "failed") {
    return (
      <div className={css.page} data-web-extensions>
        {renderHeader({ canMutate: false })}
        <div className={css.banner} data-tone="danger" role="alert">
          <span>{t("extensions.loadFailed", { message: listView.message })}</span>
          <Button variant="outline" size="sm" onClick={() => void refreshList()}>
            {t("extensions.retry")}
          </Button>
        </div>
      </div>
    );
  }

  const groupLabel = (id: ExtensionGroupId): string => {
    switch (id) {
      case "attention":
        return t("extensions.group.attention");
      case "enabled":
        return t("extensions.group.enabled");
      case "disabled":
        return t("extensions.group.disabled");
    }
  };

  return (
    <div className={css.page} data-web-extensions>
      {renderHeader({ canMutate: storeError === undefined })}

      {/* Tabs + Search bar (1:1 Desktop layout) */}
      <div className={css.controlsBar}>
        <div className={css.segmented} role="tablist" aria-label={t("extensions.tabListLabel")}>
          <button
            type="button"
            role="tab"
            className={css.segmentedTab}
            aria-selected={activeTab === "installed"}
            onClick={() => {
              setActiveTab("installed");
              setSelectedCategory(null);
            }}
          >
            {t("extensions.tabInstalled", { count: String(extensions.length) })}
          </button>
          <button
            type="button"
            role="tab"
            className={css.segmentedTab}
            aria-selected={activeTab === "market"}
            onClick={openMarket}
          >
            {t("extensions.tabMarket", { count: String(market.entries.length) })}
          </button>
        </div>

        <div className={css.searchBox}>
          <span className={css.searchIcon} aria-hidden="true">
            <IconSearchOutlineRegular size={13} />
          </span>
          <input
            type="search"
            className={css.searchInput}
            value={searchQuery}
            placeholder={t("extensions.searchPlaceholder")}
            aria-label={t("extensions.searchLabel")}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
          />
          {searchQuery !== "" && (
            <button
              type="button"
              className={css.searchClear}
              aria-label={t("extensions.clearSearch")}
              title={t("extensions.clearSearch")}
              onClick={() => setSearchQuery("")}
            >
              <IconCloseOutlineRegular size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Category filter pills */}
      {availableCategories.length > 0 && (
        <div
          className={css.categoryBar}
          role="group"
          aria-label={t("extensions.categoryFilterLabel")}
        >
          <button
            type="button"
            className={css.filterPill}
            aria-pressed={selectedCategory === null}
            onClick={() => setSelectedCategory(null)}
          >
            {t("extensions.categoryAll")}
          </button>
          {availableCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={css.filterPill}
              aria-pressed={selectedCategory === cat}
              onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
            >
              {categoryLabelForLocale(cat, contentLocale)}
            </button>
          ))}
        </div>
      )}

      {/* Global status banners */}
      {safeMode && (
        <div className={css.banner} data-tone="warning" role="status">
          <span>{t("extensions.safeMode")}</span>
        </div>
      )}

      {storeError !== undefined && (
        <div className={css.banner} data-tone="danger" role="alert">
          <span>{t("extensions.storeError", { message: storeError })}</span>
        </div>
      )}

      {feedback !== null && (
        <div
          className={css.banner}
          data-tone={feedback.tone}
          role={feedback.tone === "success" ? "status" : "alert"}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            className={css.bannerClose}
            aria-label={t("extensions.close")}
            onClick={() => setFeedback(null)}
          >
            <IconCloseOutlineRegular size={12} />
          </button>
        </div>
      )}

      {/* Active Tab Content */}
      {activeTab === "installed" ? (
        extensions.length === 0 ? (
          <div className={css.emptyCard}>
            <div className={css.emptyCopy}>
              <h3 className={css.emptyTitle}>{t("extensions.empty")}</h3>
              <p className={css.emptyDesc}>{t("extensions.emptyHint")}</p>
            </div>
            <div className={css.emptyActions}>
              <Button variant="primary" size="sm" onClick={openMarket}>
                {t("extensions.goToMarket")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={storeError !== undefined}
                onClick={() => {
                  setInstallError(null);
                  setInstallOpen(true);
                }}
              >
                {t("extensions.add")}
              </Button>
            </div>
          </div>
        ) : groupedInstalled.length === 0 ? (
          <div className={css.emptyCard}>
            <div className={css.emptyCopy}>
              <h3 className={css.emptyTitle}>{t("extensions.noMatchesTitle")}</h3>
              <p className={css.emptyDesc}>{t("extensions.noMatchesDescription")}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setSelectedCategory(null);
              }}
            >
              {t("extensions.clearFilters")}
            </Button>
          </div>
        ) : (
          <div className={css.groups}>
            {groupedInstalled.map((group) => (
              <section key={group.id} className={css.group} data-extension-group={group.id}>
                <div className={css.groupHead}>
                  <h3 className={css.groupTitle}>{groupLabel(group.id)}</h3>
                  <span className={css.groupCount}>{group.items.length}</span>
                </div>
                <div className={css.grid}>
                  {group.items.map((item) => {
                    const key = extensionKey(item.format, item.id);
                    if (isNativeExtension(item)) {
                      const catalogEntry = catalogById.get(item.id);
                      const displayName = nativeDisplayName(item, contentLocale, catalogEntry);
                      const description = nativeDescription(item, contentLocale, catalogEntry);
                      const updateAvailable = hasNativeCatalogUpdate(item, catalogEntry);
                      const blocked = isNativeToggleBlocked(item);

                      const statusDot =
                        item.error !== undefined || item.manifest === undefined
                          ? { tone: "danger" as const, label: t("extensions.state.error") }
                          : item.backendState === "failed"
                            ? { tone: "danger" as const, label: t("extensions.backend.failed") }
                            : undefined;

                      const attention = item.error
                        ? { tone: "danger" as const, text: item.error }
                        : item.manifest === undefined
                          ? { tone: "danger" as const, text: t("extensions.manifestMissing") }
                          : item.backendState === "failed"
                            ? { tone: "danger" as const, text: t("extensions.backendFailedNotice") }
                            : undefined;

                      return (
                        <WebExtensionCard
                          key={key}
                          cardKey={key}
                          extensionId={item.id}
                          format="codexhost"
                          cardKind="installed"
                          displayName={displayName}
                          description={description}
                          iconUrl={resolveNativeIconUrl(item, catalogEntry)}
                          author={item.manifest?.author ?? catalogEntry?.author}
                          version={item.version ?? item.manifest?.version}
                          repository={item.manifest?.repository ?? catalogEntry?.repository}
                          stars={catalogEntry?.stars}
                          downloads={catalogEntry?.downloads}
                          trustTier={catalogEntry?.trustTier}
                          categories={item.manifest?.categories ?? catalogEntry?.categories}
                          statusDot={statusDot}
                          updateHint={
                            updateAvailable && catalogEntry
                              ? {
                                  label: t("extensions.updateAvailable"),
                                  title: t("extensions.updateToVersion", {
                                    version: catalogEntry.version.replace(/^v/u, ""),
                                  }),
                                }
                              : undefined
                          }
                          attention={attention}
                          busy={activeAction === `toggle:codexhost:${item.id}`}
                          contentLocale={contentLocale}
                          t={t}
                          actionControl={
                            <Switch
                              label={displayName}
                              checked={item.enabled}
                              disabled={busy || blocked || storeError !== undefined}
                              title={blocked ? t("extensions.toggleBlockedInvalid") : undefined}
                              onChange={(next) => handleToggleNative(item, next, false)}
                            />
                          }
                          onOpenDetails={() => {
                            setModalFeedback(null);
                            setSelectedRef({ kind: "installed", format: "codexhost", id: item.id });
                          }}
                        />
                      );
                    }

                    const enabled = item.enabledTargets.includes("web");
                    const loaded = dshLoadedIds.includes(item.id);
                    const { title, description } = dshText(item, resolveText);
                    const statusDot = item.loadError
                      ? { tone: "danger" as const, label: t("extensions.state.error") }
                      : enabled !== loaded && !safeMode
                        ? { tone: "warning" as const, label: t("extensions.state.pending") }
                        : undefined;
                    const attention = item.loadError
                      ? {
                          tone: "danger" as const,
                          text: formatWebExtensionError(item.loadError, t),
                        }
                      : item.meta?.error
                        ? {
                            tone: "warning" as const,
                            text: t("extensions.metadataError", { message: item.meta.error }),
                          }
                        : enabled !== loaded && !safeMode
                          ? { tone: "warning" as const, text: t("extensions.pendingRestart") }
                          : undefined;

                    return (
                      <WebExtensionCard
                        key={key}
                        cardKey={key}
                        extensionId={item.id}
                        format="dsh"
                        cardKind="installed"
                        displayName={title}
                        description={description}
                        iconUrl={item.meta?.icon}
                        version={item.version}
                        repository={item.projectUrl}
                        statusDot={statusDot}
                        attention={attention}
                        busy={activeAction === `toggle:dsh:${item.id}`}
                        contentLocale={contentLocale}
                        t={t}
                        actionControl={
                          <Switch
                            label={title}
                            checked={enabled}
                            disabled={busy || storeError !== undefined}
                            onChange={(next) => handleToggleDsh(item, next, false)}
                          />
                        }
                        onOpenDetails={() => {
                          setModalFeedback(null);
                          setSelectedRef({ kind: "installed", format: "dsh", id: item.id });
                        }}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )
      ) : (
        /* Market Tab */
        <div className={css.marketBody}>
          {market.stale && market.entries.length > 0 && (
            <div className={css.marketNotice} role="status" data-market-stale="true">
              <div className={css.marketNoticeCopy}>
                <IconInfoOutlineRegular size={14} className={css.marketNoticeIcon} />
                <span>{t("extensions.marketStaleNotice")}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={market.loading}
                onClick={() => void refreshMarket()}
              >
                {t("extensions.retry")}
              </Button>
            </div>
          )}

          {market.loading && !market.loaded ? (
            <p className={css.hint}>{t("extensions.marketLoading")}</p>
          ) : market.error !== null && market.entries.length === 0 ? (
            <div className={css.emptyCard} role="alert">
              <div className={css.emptyCopy}>
                <h3 className={css.emptyTitle}>
                  {t("extensions.marketLoadFailed", { message: market.error })}
                </h3>
                <p className={css.emptyDesc}>{t("extensions.marketEmptyDescription")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={market.loading}
                onClick={() => void refreshMarket()}
              >
                {t("extensions.retry")}
              </Button>
            </div>
          ) : market.entries.length === 0 ? (
            <div className={css.emptyCard}>
              <div className={css.emptyCopy}>
                <h3 className={css.emptyTitle}>{t("extensions.marketEmptyTitle")}</h3>
                <p className={css.emptyDesc}>{t("extensions.marketEmptyDescription")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={market.loading}
                onClick={() => void refreshMarket()}
              >
                {t("extensions.refresh")}
              </Button>
            </div>
          ) : filteredMarket.length === 0 ? (
            <div className={css.emptyCard}>
              <div className={css.emptyCopy}>
                <h3 className={css.emptyTitle}>{t("extensions.noMatchesTitle")}</h3>
                <p className={css.emptyDesc}>{t("extensions.noMatchesDescription")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedCategory(null);
                }}
              >
                {t("extensions.clearFilters")}
              </Button>
            </div>
          ) : (
            <div className={css.grid}>
              {filteredMarket.map((entry) => {
                const displayName = resolveLocalizedExtensionText(entry.name, contentLocale);
                const description = resolveOptionalLocalizedText(entry.description, contentLocale);
                const installed = nativeById.get(entry.id);
                const compatible = isCatalogEntryWebCompatible(entry);
                const updateAvailable = hasNativeCatalogUpdate(installed, entry);
                const isInstalling = activeAction === `install:${entry.id}`;
                const isUpdating = activeAction === `update:${entry.id}`;

                const actionButton = !compatible ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    title={t("extensions.marketIncompatible")}
                  >
                    {t("extensions.incompatibleBadge")}
                  </Button>
                ) : !installed ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || storeError !== undefined}
                    aria-busy={isInstalling}
                    onClick={() => handleInstallMarket(entry, false)}
                  >
                    {t(isInstalling ? "extensions.installing" : "extensions.install")}
                  </Button>
                ) : updateAvailable && installed.digest ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || storeError !== undefined}
                    aria-busy={isUpdating}
                    onClick={() => handleUpdateNative(installed, entry, false)}
                  >
                    {t(isUpdating ? "extensions.updating" : "extensions.update")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<InstalledCheckIcon />}
                    disabled={busy}
                    onClick={() => {
                      setModalFeedback(null);
                      setSelectedRef({ kind: "market", id: entry.id });
                    }}
                  >
                    {t("extensions.installedBadge")}
                  </Button>
                );

                return (
                  <WebExtensionCard
                    key={extensionKey("codexhost", entry.id)}
                    cardKey={`market:${entry.id}`}
                    extensionId={entry.id}
                    format="codexhost"
                    cardKind="market"
                    displayName={displayName}
                    description={description}
                    iconUrl={entry.icon}
                    author={entry.author}
                    version={entry.version}
                    repository={entry.repository}
                    stars={entry.stars}
                    downloads={entry.downloads}
                    trustTier={entry.trustTier}
                    categories={entry.categories}
                    attention={
                      !compatible
                        ? { tone: "warning", text: t("extensions.marketIncompatible") }
                        : undefined
                    }
                    busy={isInstalling || isUpdating}
                    contentLocale={contentLocale}
                    t={t}
                    actionControl={actionButton}
                    onOpenDetails={() => {
                      setModalFeedback(null);
                      setSelectedRef({ kind: "market", id: entry.id });
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      <InstallWebExtensionDialog
        t={t}
        open={installOpen}
        busy={activeAction === "install:manual"}
        error={installError}
        onClose={() => setInstallOpen(false)}
        onInstall={handleManualInstall}
      />

      <CreateWebExtensionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        contentLocale={contentLocale}
      />

      <WebExtensionDetailModal
        open={detailTarget !== null}
        target={detailTarget}
        dshLoadedIds={dshLoadedIds}
        safeMode={safeMode}
        storeError={storeError}
        busy={busy}
        activeAction={activeAction}
        feedback={modalFeedback}
        locale={contentLocale}
        resolveText={resolveText}
        t={t}
        onClose={() => {
          setSelectedRef(null);
          setModalFeedback(null);
        }}
        onToggleNative={(item, enabled) => handleToggleNative(item, enabled, true)}
        onToggleDsh={(item, enabled) => handleToggleDsh(item, enabled, true)}
        onInstallMarket={(entry) => handleInstallMarket(entry, true)}
        onUpdateNative={(item, entry) => handleUpdateNative(item, entry, true)}
        onUninstallNative={handleUninstallNative}
        onUninstallDsh={handleUninstallDsh}
      />
    </div>
  );
}
