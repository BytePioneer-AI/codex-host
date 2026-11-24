/**
 * Unified Plugins workspace backed by the shared Host (`codexhost/extensions/*`).
 *
 * Displays all installed plugins and the unified Marketplace (`catalog.v2.json`), capability
 * badges and filters, ZIP / GitHub / local-directory import, declarative settings, recovery
 * actions, and the cross-platform standalone `page` container.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Modal,
  Switch,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  resolveLocalizedExtensionText,
  type DesktopExtensionCategory,
  type HostExtensionCatalogEntry,
  type HostExtensionInstallation,
  type HostExtensionListItem,
  type HostExtensionsListResult,
} from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";
import {
  hostExtensionsApi,
  isHostExtensionAuthDisabledError,
  isHostExtensionRevisionConflictError,
  isHostExtensionUnavailableError,
} from "./web-native-extension-management-api.ts";
import {
  CAPABILITY_FILTER_ORDER,
  CATEGORY_ORDER,
  capabilityFilterLabel,
  catalogCapabilities,
  categoryLabelForLocale,
  deriveHostCapabilityBadges,
  derivePlatformBadge,
  formatManagementError,
  hasHostCatalogUpdate,
  hostDescription,
  hostDisplayName,
  isHostToggleBlocked,
  itemCapabilities,
  itemTargets,
  matchesCapabilityFilter,
  matchesCatalogSearch,
  matchesInstalledSearch,
  needsAttention,
  resolveHostIconUrl,
  resolveOptionalLocalizedText,
  type ExtensionCapabilityFilter,
  type ExtensionLocale,
  type HostExtensionValidItem,
} from "./web-extensions-helpers.ts";
import { InstalledCheckIcon, WebExtensionCard } from "./WebExtensionCard.tsx";
import { WebExtensionDetailModal, type DetailModalTarget } from "./WebExtensionDetailModal.tsx";
import {
  InstallWebExtensionDialog,
  type InstallWebExtensionRequest,
} from "./InstallWebExtensionDialog.tsx";
import { CreateWebExtensionDialog } from "./CreateWebExtensionDialog.tsx";
import { HostExtensionPageView } from "./HostExtensionPageView.tsx";
import css from "./WebExtensionsSection.module.css";

type ActiveTab = "installed" | "market";
export type ContentLocalePreference = "system" | ExtensionLocale;

type ListView =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: HostExtensionsListResult }
  | { readonly kind: "disabled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

interface MarketState {
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly entries: readonly HostExtensionCatalogEntry[];
  readonly error: { readonly cause: unknown } | null;
}

type SelectedRef =
  | { readonly kind: "installed"; readonly id: string }
  | { readonly kind: "market"; readonly id: string };

type Feedback = { readonly tone: "success" | "warning" | "danger"; readonly text: string };

export interface WebExtensionsFace {
  locale: HostSettingsSource<string>;
  colorScheme: HostSettingsSource<"light" | "dark">;
  contentLocale: ExtensionLocale;
  contentLocalePref: ContentLocalePreference;
  selectContentLocale: (next: ContentLocalePreference) => void;
  selectedPage: HostExtensionInstallation | null;
  selectPage: (page: HostExtensionInstallation) => void;
  onUpdatesChange?: (hasUpdates: boolean) => void;
}

const INITIAL_MARKET: MarketState = {
  loading: false,
  loaded: false,
  entries: [],
  error: null,
};

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

export function WebExtensionsSection({
  t,
  locale,
  colorScheme,
  contentLocale,
  contentLocalePref,
  selectContentLocale,
  selectedPage,
  selectPage,
  onUpdatesChange,
}: PropsLocale<"codexhostImport"> & WebExtensionsFace): ReactNode {
  const [listView, setListView] = useState<ListView>({ kind: "loading" });
  const [market, setMarket] = useState<MarketState>(INITIAL_MARKET);
  const [activeTab, setActiveTab] = useState<ActiveTab>("installed");
  const [searchQuery, setSearchQuery] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState<ExtensionCapabilityFilter>("all");
  const [selectedCategory, setSelectedCategory] = useState<DesktopExtensionCategory | null>(null);

  const [localeMenuOpen, setLocaleMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
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

  const refreshList = useCallback(
    async (signal?: AbortSignal): Promise<HostExtensionsListResult | null> => {
      try {
        const data = await hostExtensionsApi.list(signal);
        if (signal?.aborted || !mountedRef.current) return null;
        setListView({ kind: "ready", data });
        return data;
      } catch (cause: unknown) {
        if (signal?.aborted || !mountedRef.current) return null;
        if (isHostExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
        } else if (isHostExtensionUnavailableError(cause)) {
          setListView({ kind: "unavailable" });
        } else {
          setListView({ kind: "failed", message: formatManagementError(cause, t) });
        }
        return null;
      }
    },
    [t],
  );

  const refreshMarket = useCallback(
    async (forceRefresh = false, signal?: AbortSignal): Promise<void> => {
      setMarket((prev) => ({ ...prev, loading: true }));
      try {
        const result = await hostExtensionsApi.catalog({ forceRefresh }, signal);
        if (signal?.aborted || !mountedRef.current) return;
        setMarket({
          loading: false,
          loaded: true,
          entries: result.extensions,
          error: null,
        });
      } catch (cause: unknown) {
        if (signal?.aborted || !mountedRef.current) return;
        setMarket((prev) => ({ ...prev, loading: false, error: { cause } }));
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshMarket(false, controller.signal);
    return () => controller.abort();
  }, [refreshMarket]);

  const openMarket = () => {
    setActiveTab("market");
    setSelectedCategory(null);
  };

  // Initial load + live synchronization on `extensions-changed` client channel events.
  useEffect(() => {
    const controller = new AbortController();
    void refreshList(controller.signal);
    const unsubscribe = subscribeHostExtensionEvents({
      document,
      onExtensionsChanged: () => {
        if (!mountedRef.current) return;
        void refreshList();
      },
      onReconnect: () => {
        if (!mountedRef.current) return;
        void refreshList();
      },
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [refreshList]);

  const runMutation = useCallback(
    async (
      actionKey: string,
      operation: () => Promise<{ readonly conflict?: boolean } | void>,
      options?: {
        readonly successText?: string;
        readonly target?: "page" | "modal" | "install";
        readonly onSuccess?: () => void;
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
        const outcome = await operation();
        if (!mountedRef.current) return true;
        await refreshList();
        if (!mountedRef.current) return true;
        if (outcome && outcome.conflict) {
          const msg: Feedback = { tone: "warning", text: t("extensions.error.stale") };
          if (target === "install") setInstallError(msg.text);
          else if (target === "modal") setModalFeedback(msg);
          else setFeedback(msg);
          return false;
        }
        if (options?.successText) {
          const msg: Feedback = { tone: "success", text: options.successText };
          if (target === "modal") setModalFeedback(msg);
          else setFeedback(msg);
        }
        options?.onSuccess?.();
        return true;
      } catch (cause: unknown) {
        if (!mountedRef.current) return false;
        if (isHostExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
          setInstallOpen(false);
          setSelectedRef(null);
          return false;
        }
        const message = formatManagementError(cause, t);
        if (isHostExtensionRevisionConflictError(cause)) {
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

  const listData = listView.kind === "ready" ? listView.data : null;
  const extensions = useMemo(() => listData?.extensions ?? [], [listData]);
  const diagnostics = useMemo(() => listData?.diagnostics ?? [], [listData]);
  const configRevision = listData?.configuration.revision ?? 0;

  const installedById = useMemo(() => {
    const map = new Map<string, HostExtensionListItem>();
    for (const item of extensions) {
      map.set(item.id, item);
    }
    return map;
  }, [extensions]);

  const catalogById = useMemo(() => {
    const map = new Map<string, HostExtensionCatalogEntry>();
    for (const entry of market.entries) {
      map.set(entry.id, entry);
    }
    return map;
  }, [market.entries]);

  const hasInstalledUpdates = useMemo(
    () => extensions.some((item) => hasHostCatalogUpdate(item, catalogById.get(item.id))),
    [extensions, catalogById],
  );

  useEffect(() => {
    if (listView.kind === "ready" && market.loaded) {
      onUpdatesChange?.(hasInstalledUpdates);
    } else if (listView.kind === "disabled") {
      onUpdatesChange?.(false);
    }
  }, [listView.kind, market.loaded, hasInstalledUpdates, onUpdatesChange]);

  const availableCategories = useMemo(() => {
    const present = new Set<DesktopExtensionCategory>();
    if (activeTab === "installed") {
      for (const item of extensions) {
        if (item.state === "valid") {
          for (const cat of item.manifest.categories ?? []) present.add(cat);
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
      if (!matchesCapabilityFilter(capabilityFilter, itemCapabilities(item), itemTargets(item))) {
        return false;
      }
      if (selectedCategory !== null) {
        if (item.state !== "valid") return false;
        if (!item.manifest.categories?.includes(selectedCategory)) return false;
      }
      return matchesInstalledSearch(item, normalizedQuery, t);
    });
  }, [extensions, capabilityFilter, selectedCategory, normalizedQuery, t]);

  const groupedInstalled = useMemo(() => {
    const attention: HostExtensionListItem[] = [];
    const normal: HostExtensionListItem[] = [];
    for (const item of filteredInstalled) {
      (needsAttention(item) ? attention : normal).push(item);
    }
    normal.sort((left, right) => {
      const leftName = hostDisplayName(left, contentLocale, catalogById.get(left.id));
      const rightName = hostDisplayName(right, contentLocale, catalogById.get(right.id));
      return (
        leftName.localeCompare(rightName, contentLocale) || left.id.localeCompare(right.id, "en")
      );
    });
    return [
      { id: "attention", items: attention },
      { id: "normal", items: normal },
    ].filter((group) => group.items.length > 0);
  }, [filteredInstalled, contentLocale, catalogById]);

  const filteredMarket = useMemo(() => {
    return market.entries.filter((entry) => {
      if (!matchesCapabilityFilter(capabilityFilter, catalogCapabilities(entry), entry.targets)) {
        return false;
      }
      if (selectedCategory !== null && !entry.categories?.includes(selectedCategory)) {
        return false;
      }
      return matchesCatalogSearch(entry, normalizedQuery, t);
    });
  }, [market.entries, capabilityFilter, selectedCategory, normalizedQuery, t]);

  const detailTarget: DetailModalTarget | null = useMemo(() => {
    if (selectedRef === null) return null;
    const item = installedById.get(selectedRef.id);
    const catalog = catalogById.get(selectedRef.id);
    if (!item && !catalog) return null;
    return { item, catalog };
  }, [selectedRef, installedById, catalogById]);

  const busy = activeAction !== null;

  const handleToggle = (item: HostExtensionListItem, enabled: boolean, fromModal: boolean) => {
    const name = hostDisplayName(item, contentLocale, catalogById.get(item.id));
    void runMutation(
      `toggle:${item.id}`,
      async () => {
        const res = enabled
          ? await hostExtensionsApi.enable({ id: item.id, expectedRevision: configRevision })
          : await hostExtensionsApi.disable({ id: item.id, expectedRevision: configRevision });
        if (res.state === "revision-conflict") return { conflict: true };
        return undefined;
      },
      {
        target: fromModal ? "modal" : "page",
        successText: t(enabled ? "extensions.savedEnabled" : "extensions.savedDisabled", { name }),
      },
    );
  };

  const handleInstallMarket = (entry: HostExtensionCatalogEntry, fromModal: boolean) => {
    const name = resolveLocalizedExtensionText(entry.name, contentLocale);
    void runMutation(
      `install:${entry.id}`,
      async () => {
        await hostExtensionsApi.install({
          source: {
            type: "catalog",
            id: entry.id,
          },
        });
      },
      {
        target: fromModal ? "modal" : "page",
        successText: t("extensions.installedSuccess", { name }),
      },
    );
  };

  const handleUpdate = (
    item: HostExtensionValidItem,
    entry: HostExtensionCatalogEntry,
    fromModal: boolean,
  ) => {
    const name = hostDisplayName(item, contentLocale, entry);
    void runMutation(
      `update:${item.id}`,
      async () => {
        await hostExtensionsApi.update({
          id: item.id,
          expectedDigest: item.digest,
          expectedActivationId: item.activationId,
          source: {
            type: "catalog",
            id: entry.id,
          },
        });
      },
      {
        target: fromModal ? "modal" : "page",
        successText: t("extensions.updatedSuccess", {
          name,
          version: entry.version.replace(/^v/u, ""),
        }),
      },
    );
  };

  const handleUninstall = (item: HostExtensionListItem) => {
    const name = hostDisplayName(item, contentLocale, catalogById.get(item.id));
    const hasCatalog = catalogById.has(item.id);
    void runMutation(
      `uninstall:${item.id}`,
      async () => {
        await hostExtensionsApi.uninstall({ id: item.id });
      },
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

  const handleRecover = () => {
    void runMutation(
      "recover",
      async () => {
        const res = await hostExtensionsApi.recover({ expectedRevision: configRevision });
        if (res.state === "revision-conflict") return { conflict: true };
        return undefined;
      },
      {
        target: "page",
        successText: t("extensions.recover.success"),
        onSuccess: () => setRecoverOpen(false),
      },
    );
  };

  const handleManualInstall = (request: InstallWebExtensionRequest): Promise<boolean> => {
    if (request.kind === "zip") {
      return runMutation(
        "install:manual",
        async () => {
          await hostExtensionsApi.uploadZip(request.file);
        },
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
    if (request.kind === "github") {
      return runMutation(
        "install:manual",
        async () => {
          await hostExtensionsApi.install({ source: request.source });
        },
        {
          target: "install",
          successText: t("extensions.installedSuccess", { name: request.source.repository }),
          onSuccess: () => {
            setInstallOpen(false);
            setActiveTab("installed");
          },
        },
      );
    }
    return runMutation(
      "install:manual",
      async () => {
        await hostExtensionsApi.install({
          source: { type: "localDir", localDir: request.localDir },
        });
      },
      {
        target: "install",
        successText: t("extensions.installedSuccess", { name: request.localDir }),
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
    if (!market.loading) void refreshMarket(true);
  };

  if (selectedPage !== null) {
    return (
      <div className={css.standalone} data-web-extensions data-page-open={selectedPage.id}>
        <HostExtensionPageView
          key={`${selectedPage.id}:${selectedPage.activationId}:${selectedPage.digest}`}
          item={selectedPage}
          catalogIcon={catalogById.get(selectedPage.id)?.icon}
          locale={locale}
          colorScheme={colorScheme}
          contentLocale={contentLocale}
          t={t}
        />
      </div>
    );
  }

  const renderHeader = (options: { readonly canMutate: boolean }) => (
    <header className={css.header}>
      <div className={css.headerLeft}>
        <h2 className={css.title}>{t("extensions.center")}</h2>
      </div>

      <div className={css.toolbar}>
        {/* Content language switcher */}
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
                    onClick={() => {
                      selectContentLocale(value);
                      setLocaleMenuOpen(false);
                    }}
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

        {/* Create plugin button */}
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

        {/* Import plugin button */}
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

        {/* More ("...") menu: disable all plugins (recover) + legacy DSH recovery link */}
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
              {options.canMutate && (
                <button
                  type="button"
                  role="menuitem"
                  className={`${css.menuItem} ${css.menuItemDanger}`}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setRecoverOpen(true);
                  }}
                >
                  {t("extensions.recover.action")}
                </button>
              )}
              {options.canMutate && <div className={css.menuDivider} role="separator" />}
              <a
                className={css.menuItem}
                role="menuitem"
                href="/extensions"
                onClick={() => setMoreMenuOpen(false)}
              >
                {t("extensions.legacyDshRecovery")}
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

  if (listView.kind === "unavailable") {
    return (
      <div className={css.page} data-web-extensions>
        {renderHeader({ canMutate: false })}
        <div className={css.emptyCard} data-web-extensions-notice="unavailable">
          <div className={css.emptyCopy}>
            <p className={css.emptyDesc}>{t("extensions.unavailable")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refreshList()}>
            {t("extensions.retry")}
          </Button>
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

  return (
    <div className={css.page} data-web-extensions>
      {renderHeader({ canMutate: true })}

      {/* Tabs + Search bar */}
      <div className={css.controlsBar}>
        <div className={css.segmented} role="tablist" aria-label={t("extensions.tabListLabel")}>
          <button
            type="button"
            role="tab"
            className={css.segmentedTab}
            aria-selected={activeTab === "installed"}
            aria-description={
              hasInstalledUpdates ? t("extensions.installedUpdatesAvailable") : undefined
            }
            onClick={() => {
              setActiveTab("installed");
              setSelectedCategory(null);
            }}
          >
            {t("extensions.tabInstalled", { count: String(extensions.length) })}
            {hasInstalledUpdates && <span className={css.tabUpdateDot} aria-hidden="true" />}
          </button>
          <button
            type="button"
            role="tab"
            className={css.segmentedTab}
            aria-selected={activeTab === "market"}
            onClick={openMarket}
          >
            {market.loaded
              ? t("extensions.tabMarketCount", { count: String(market.entries.length) })
              : t("extensions.tabMarket")}
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

      {/* Capability filter + Category filter pills */}
      <div className={css.filterRows}>
        <div
          className={css.capabilityBar}
          role="group"
          aria-label={t("extensions.filter.label")}
          data-capability-filters
        >
          {CAPABILITY_FILTER_ORDER.map((filter) => (
            <button
              key={filter}
              type="button"
              className={css.filterPill}
              aria-pressed={capabilityFilter === filter}
              data-capability-filter={filter}
              onClick={() => setCapabilityFilter(filter)}
            >
              {capabilityFilterLabel(filter, t)}
            </button>
          ))}
        </div>

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
      </div>

      {/* Host diagnostics banner */}
      {diagnostics.length > 0 && (
        <div className={css.banner} data-tone="warning" role="status">
          <span>{diagnostics.join(" · ")}</span>
        </div>
      )}

      {/* Action feedback banner */}
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
                setCapabilityFilter("all");
                setSelectedCategory(null);
              }}
            >
              {t("extensions.clearFilters")}
            </Button>
          </div>
        ) : (
          <div className={css.groups}>
            {groupedInstalled.map((group) => {
              const grid = (
                <div key={group.id} className={css.grid}>
                  {group.items.map((item) => {
                    const catalogEntry = catalogById.get(item.id);
                    const validItem = item.state === "valid" ? item : undefined;
                    const displayName = hostDisplayName(item, contentLocale, catalogEntry);
                    const description = hostDescription(item, contentLocale, catalogEntry);
                    const isUpdating = activeAction === `update:${item.id}`;
                    const blocked = isHostToggleBlocked(item);
                    const capabilityBadges = deriveHostCapabilityBadges(itemCapabilities(item), t);

                    const statusDot =
                      item.state !== "valid"
                        ? { tone: "danger" as const, label: t("extensions.state.error") }
                        : item.backendState === "failed"
                          ? { tone: "danger" as const, label: t("extensions.backend.failed") }
                          : item.desktopConflictWith
                            ? { tone: "warning" as const, label: t("extensions.state.conflict") }
                            : undefined;

                    const attention =
                      item.state !== "valid"
                        ? {
                            tone:
                              item.state === "incompatible"
                                ? ("warning" as const)
                                : ("danger" as const),
                            text: item.error || t("extensions.manifestMissing"),
                          }
                        : item.backendState === "failed"
                          ? {
                              tone: "danger" as const,
                              text: item.backendError || t("extensions.backendFailedNotice"),
                            }
                          : item.desktopConflictWith
                            ? {
                                tone: "warning" as const,
                                text: t("extensions.desktopConflictNotice", {
                                  other: item.desktopConflictWith,
                                }),
                              }
                            : undefined;

                    const canOpenPage = Boolean(
                      validItem && validItem.enabled && validItem.manifest.page,
                    );

                    return (
                      <WebExtensionCard
                        key={item.id}
                        cardKey={`host:${item.id}`}
                        extensionId={item.id}
                        cardKind="installed"
                        displayName={displayName}
                        description={description}
                        iconUrl={resolveHostIconUrl(item, catalogEntry)}
                        author={validItem?.manifest.author ?? catalogEntry?.author}
                        version={validItem?.manifest.version}
                        downloads={catalogEntry?.downloads}
                        trustTier={catalogEntry?.trustTier}
                        categories={validItem?.manifest.categories ?? catalogEntry?.categories}
                        platformBadge={derivePlatformBadge(itemTargets(item), t)}
                        capabilityBadges={capabilityBadges}
                        statusDot={statusDot}
                        update={
                          validItem && catalogEntry && hasHostCatalogUpdate(validItem, catalogEntry)
                            ? {
                                label: t("extensions.updateVersionCue", {
                                  version: catalogEntry.version.replace(/^v/u, ""),
                                }),
                                action: (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    disabled={busy}
                                    aria-busy={isUpdating}
                                    onClick={() => handleUpdate(validItem, catalogEntry, false)}
                                  >
                                    {t(isUpdating ? "extensions.updating" : "extensions.update")}
                                  </Button>
                                ),
                              }
                            : undefined
                        }
                        attention={attention}
                        busy={isUpdating || activeAction === `toggle:${item.id}`}
                        contentLocale={contentLocale}
                        t={t}
                        secondaryAction={
                          canOpenPage && validItem ? (
                            <button
                              type="button"
                              className={css.openPageButton}
                              data-action="open-page"
                              data-extension-id={validItem.id}
                              disabled={busy}
                              onClick={() => selectPage(validItem)}
                            >
                              {t("extensions.page.open")}
                            </button>
                          ) : undefined
                        }
                        actionControl={
                          <Switch
                            label={displayName}
                            checked={item.enabled}
                            disabled={busy || blocked}
                            title={blocked ? t("extensions.toggleBlockedInvalid") : undefined}
                            onChange={(next) => handleToggle(item, next, false)}
                          />
                        }
                        onOpenDetails={() => {
                          setModalFeedback(null);
                          setSelectedRef({ kind: "installed", id: item.id });
                        }}
                      />
                    );
                  })}
                </div>
              );
              return group.id === "attention" ? (
                <section key={group.id} className={css.group} data-extension-group="attention">
                  <div className={css.groupHead}>
                    <h3 className={css.groupTitle}>{t("extensions.group.attention")}</h3>
                    <span className={css.groupCount}>{group.items.length}</span>
                  </div>
                  {grid}
                </section>
              ) : (
                grid
              );
            })}
          </div>
        )
      ) : (
        /* Unified Marketplace Tab (catalog.v2.json — all targets) */
        <div className={css.marketBody}>
          {market.error !== null && market.entries.length > 0 && (
            <div className={css.marketNotice} role="status" data-market-stale="true">
              <div className={css.marketNoticeCopy}>
                <IconInfoOutlineRegular size={14} className={css.marketNoticeIcon} />
                <span>{t("extensions.marketStaleNotice")}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={market.loading}
                onClick={() => void refreshMarket(true)}
              >
                {t("extensions.retry")}
              </Button>
            </div>
          )}

          {!market.loaded && (market.loading || market.error === null) ? (
            <p className={css.hint}>{t("extensions.marketLoading")}</p>
          ) : market.error !== null && market.entries.length === 0 ? (
            <div className={css.emptyCard} role="alert">
              <div className={css.emptyCopy}>
                <h3 className={css.emptyTitle}>
                  {t("extensions.marketLoadFailed", {
                    message: formatManagementError(market.error.cause, t),
                  })}
                </h3>
                <p className={css.emptyDesc}>{t("extensions.marketEmptyDescription")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={market.loading}
                onClick={() => void refreshMarket(true)}
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
                onClick={() => void refreshMarket(true)}
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
                  setCapabilityFilter("all");
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
                const installed = installedById.get(entry.id);
                const validInstalled = installed?.state === "valid" ? installed : undefined;
                const updateAvailable = hasHostCatalogUpdate(installed, entry);
                const isInstalling = activeAction === `install:${entry.id}`;
                const isUpdating = activeAction === `update:${entry.id}`;
                const capabilityBadges = deriveHostCapabilityBadges(catalogCapabilities(entry), t);

                const actionButton = !installed ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    aria-busy={isInstalling}
                    onClick={() => handleInstallMarket(entry, false)}
                  >
                    {t(isInstalling ? "extensions.installing" : "extensions.install")}
                  </Button>
                ) : updateAvailable && validInstalled ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    aria-busy={isUpdating}
                    onClick={() => handleUpdate(validInstalled, entry, false)}
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
                    key={entry.id}
                    cardKey={`market:${entry.id}`}
                    extensionId={entry.id}
                    cardKind="market"
                    displayName={displayName}
                    description={description}
                    iconUrl={entry.icon}
                    author={entry.author}
                    version={entry.version}
                    downloads={entry.downloads}
                    trustTier={entry.trustTier}
                    categories={entry.categories}
                    platformBadge={derivePlatformBadge(entry.targets, t)}
                    capabilityBadges={capabilityBadges}
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
        busy={busy}
        activeAction={activeAction}
        feedback={modalFeedback}
        locale={contentLocale}
        t={t}
        onClose={() => {
          setSelectedRef(null);
          setModalFeedback(null);
        }}
        onToggle={(item, enabled) => handleToggle(item, enabled, true)}
        onInstallMarket={(entry) => handleInstallMarket(entry, true)}
        onUpdate={(item, entry) => handleUpdate(item, entry, true)}
        onUninstall={handleUninstall}
        onOpenPage={selectPage}
      />

      <Modal
        open={recoverOpen}
        onClose={() => {
          if (!busy) setRecoverOpen(false);
        }}
        title={t("extensions.recover.title")}
        closeLabel={t("extensions.close")}
        className={css.recoverDialog}
        footer={
          <div className={css.recoverFooter}>
            <Button variant="outline" disabled={busy} onClick={() => setRecoverOpen(false)}>
              {t("extensions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={activeAction === "recover"}
              onClick={handleRecover}
            >
              {t(
                activeAction === "recover"
                  ? "extensions.recover.running"
                  : "extensions.recover.confirm",
              )}
            </Button>
          </div>
        }
      >
        <p className={css.recoverBody}>{t("extensions.recover.description")}</p>
      </Modal>
    </div>
  );
}
