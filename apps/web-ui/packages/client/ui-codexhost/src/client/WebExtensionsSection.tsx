/**
 * Unified Plugins workspace backed by the shared Host (`codexhost/extensions/*`).
 *
 * Designed with Kettu-inspired clarity: centered reading column, title row with direct Create and
 * Import actions, single sticky navigation bar (All / Installed | business categories + compact
 * search + Filter popover + More menu), Featured 3-column showcase cards, borderless 2-column
 * community rows, cross-mount snapshot caching, SWR catalog hydration, and non-blank fading icons.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
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
  selectFeaturedCatalogEntries,
  type ExtensionCapabilityFilter,
  type ExtensionLocale,
  type HostExtensionValidItem,
} from "./web-extensions-helpers.ts";
import { InstalledCheckIcon, WebExtensionCard } from "./WebExtensionCard.tsx";
import {
  WebExtensionDetailModal,
  type DetailModalTarget,
  type ExtensionPendingAction,
} from "./WebExtensionDetailModal.tsx";
import {
  InstallWebExtensionDialog,
  type InstallWebExtensionRequest,
} from "./InstallWebExtensionDialog.tsx";
import { CreateWebExtensionDialog } from "./CreateWebExtensionDialog.tsx";
import { HostExtensionPageView } from "./HostExtensionPageView.tsx";
import css from "./WebExtensionsSection.module.css";

type NavView = "all" | "installed" | DesktopExtensionCategory;
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

interface WorkspaceCacheSnapshot {
  listData: HostExtensionsListResult | null;
  marketEntries: readonly HostExtensionCatalogEntry[] | null;
}

const workspaceSnapshots = new Map<string, WorkspaceCacheSnapshot>();

function workspaceCacheKey(): string {
  try {
    return typeof document !== "undefined" ? document.baseURI : "default";
  } catch {
    return "default";
  }
}

function readWorkspaceSnapshot(): WorkspaceCacheSnapshot | undefined {
  return workspaceSnapshots.get(workspaceCacheKey());
}

function writeWorkspaceSnapshot(patch: Partial<WorkspaceCacheSnapshot>): void {
  const key = workspaceCacheKey();
  const prev = workspaceSnapshots.get(key) ?? { listData: null, marketEntries: null };
  workspaceSnapshots.set(key, { ...prev, ...patch });
}

export interface WebExtensionsFace {
  locale: HostSettingsSource<string>;
  colorScheme: HostSettingsSource<"light" | "dark">;
  contentLocale: ExtensionLocale;
  contentLocalePref: ContentLocalePreference;
  selectContentLocale: (next: ContentLocalePreference) => void;
  selectedPage: HostExtensionInstallation | null;
  selectPage: (page: HostExtensionInstallation) => void;
  hasPageTabs?: boolean | undefined;
  onUpdatesChange?: (hasUpdates: boolean) => void;
}

function SlidersIcon(): ReactNode {
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
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="10" y1="18" x2="14" y2="18" />
    </svg>
  );
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

function MarketSkeleton(): ReactNode {
  return (
    <div className={css.skeletonWrap} aria-hidden="true">
      <div className={css.section}>
        <div className={`${css.skeletonBar} ${css.skeletonHeading}`} />
        <div className={css.featuredGrid}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={css.skeletonFeaturedCard}>
              <div className={css.featuredTop}>
                <div className={css.skeletonIcon} />
                <div className={css.skeletonBtn} />
              </div>
              <div className={`${css.skeletonBar} ${css.skeletonTitle}`} />
              <div className={`${css.skeletonBar} ${css.skeletonMeta}`} />
              <div className={`${css.skeletonBar} ${css.skeletonDesc}`} />
              <div className={`${css.skeletonBar} ${css.skeletonDescShort}`} />
            </div>
          ))}
        </div>
      </div>
      <div className={css.section}>
        <div className={`${css.skeletonBar} ${css.skeletonHeading}`} />
        <div className={css.rowGrid}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={css.skeletonRow}>
              <div className={css.skeletonIcon} />
              <div className={css.skeletonRowLines}>
                <div className={`${css.skeletonBar} ${css.skeletonTitle}`} />
                <div className={`${css.skeletonBar} ${css.skeletonMeta}`} />
                <div className={`${css.skeletonBar} ${css.skeletonDesc}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InstalledSkeleton(): ReactNode {
  return (
    <div className={css.rowGrid} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={css.skeletonRow}>
          <div className={css.skeletonIcon} />
          <div className={css.skeletonRowLines}>
            <div className={`${css.skeletonBar} ${css.skeletonTitle}`} />
            <div className={`${css.skeletonBar} ${css.skeletonMeta}`} />
            <div className={`${css.skeletonBar} ${css.skeletonDesc}`} />
          </div>
        </div>
      ))}
    </div>
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
  hasPageTabs = false,
  onUpdatesChange,
}: PropsLocale<"codexhostImport"> & WebExtensionsFace): ReactNode {
  const initialSnapshot = useMemo(() => readWorkspaceSnapshot(), []);
  const [listView, setListView] = useState<ListView>(() =>
    initialSnapshot?.listData
      ? { kind: "ready", data: initialSnapshot.listData }
      : { kind: "loading" },
  );
  const [market, setMarket] = useState<MarketState>(() =>
    initialSnapshot?.marketEntries
      ? { loading: false, loaded: true, entries: initialSnapshot.marketEntries, error: null }
      : { loading: true, loaded: false, entries: [], error: null },
  );
  const [activeView, setActiveView] = useState<NavView>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState<ExtensionCapabilityFilter>("all");

  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null);

  const [pendingById, setPendingById] = useState<ReadonlyMap<string, ExtensionPendingAction>>(
    () => new Map(),
  );
  const [manualInstalling, setManualInstalling] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [modalFeedback, setModalFeedback] = useState<
    (Feedback & { readonly extensionId: string }) | null
  >(null);

  const filterWrapRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const pendingByIdRef = useRef<Map<string, ExtensionPendingAction>>(new Map());
  const manualInstallingRef = useRef(false);
  const recoveringRef = useRef(false);
  const selectedRefCurrent = useRef<SelectedRef | null>(null);
  selectedRefCurrent.current = selectedRef;
  const configRevisionRef = useRef(initialSnapshot?.listData?.configuration.revision ?? 0);
  const toggleQueueRef = useRef<Promise<void>>(Promise.resolve());
  const listRequestTokenRef = useRef(0);
  const inFlightListRef = useRef<Promise<HostExtensionsListResult | null> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dismiss dropdown menus on outside pointerdown or Escape.
  useEffect(() => {
    if (!filterMenuOpen && !moreMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (filterMenuOpen && filterWrapRef.current && !filterWrapRef.current.contains(target)) {
        setFilterMenuOpen(false);
      }
      if (moreMenuOpen && moreWrapRef.current && !moreWrapRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilterMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterMenuOpen, moreMenuOpen]);

  const refreshList = useCallback(
    async (
      signal?: AbortSignal,
      options?: { readonly force?: boolean },
    ): Promise<HostExtensionsListResult | null> => {
      if (!options?.force && inFlightListRef.current && !signal) {
        return inFlightListRef.current;
      }
      const token = ++listRequestTokenRef.current;
      const task = (async (): Promise<HostExtensionsListResult | null> => {
        try {
          const data = await hostExtensionsApi.list(signal);
          if (signal?.aborted || !mountedRef.current || token !== listRequestTokenRef.current)
            return null;
          configRevisionRef.current = data.configuration.revision;
          writeWorkspaceSnapshot({ listData: data });
          setListView({ kind: "ready", data });
          return data;
        } catch (cause: unknown) {
          if (signal?.aborted || !mountedRef.current || token !== listRequestTokenRef.current)
            return null;
          if (isHostExtensionAuthDisabledError(cause)) {
            setListView({ kind: "disabled" });
          } else if (isHostExtensionUnavailableError(cause)) {
            setListView({ kind: "unavailable" });
          } else {
            setListView((prev) =>
              prev.kind === "ready"
                ? prev
                : { kind: "failed", message: formatManagementError(cause, t) },
            );
          }
          return null;
        } finally {
          if (inFlightListRef.current === task) {
            inFlightListRef.current = null;
          }
        }
      })();
      if (!signal) {
        inFlightListRef.current = task;
      }
      return task;
    },
    [t],
  );

  const refreshMarket = useCallback(
    async (forceRefresh = false, signal?: AbortSignal): Promise<void> => {
      setMarket((prev) => ({ ...prev, loading: true }));
      try {
        const result = await hostExtensionsApi.catalog(
          { forceRefresh, ...(forceRefresh ? {} : { staleWhileRevalidate: true }) },
          signal,
        );
        if (signal?.aborted || !mountedRef.current) return;
        writeWorkspaceSnapshot({ marketEntries: result.extensions });
        setMarket({
          loading: Boolean(result.stale),
          loaded: true,
          entries: result.extensions,
          error: null,
        });
        if (result.stale && !forceRefresh) {
          // Background refresh to pick up newly hydrated catalog once SWR finishes.
          void hostExtensionsApi
            .catalog({ forceRefresh: false, staleWhileRevalidate: false }, signal)
            .then((fresh) => {
              if (signal?.aborted || !mountedRef.current) return;
              writeWorkspaceSnapshot({ marketEntries: fresh.extensions });
              setMarket({
                loading: false,
                loaded: true,
                entries: fresh.extensions,
                error: null,
              });
            })
            .catch(() => {
              if (signal?.aborted || !mountedRef.current) return;
              setMarket((prev) => ({ ...prev, loading: false }));
            });
        }
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

  const runExtensionMutation = useCallback(
    async (
      extensionId: string,
      action: ExtensionPendingAction,
      operation: () => Promise<{ readonly conflict?: boolean } | void>,
      options?: {
        readonly successText?: string;
        readonly onSuccess?: () => void;
        readonly onFailure?: () => void;
      },
    ): Promise<boolean> => {
      if (recoveringRef.current || pendingByIdRef.current.has(extensionId)) return false;
      pendingByIdRef.current.set(extensionId, action);
      setPendingById(new Map(pendingByIdRef.current));
      if (selectedRefCurrent.current?.id === extensionId) {
        setModalFeedback((prev) => (prev?.extensionId === extensionId ? null : prev));
      } else {
        setFeedback(null);
      }

      const publishFeedback = (msg: Feedback) => {
        if (selectedRefCurrent.current?.id === extensionId) {
          setModalFeedback({ ...msg, extensionId });
        } else {
          setFeedback(msg);
        }
      };

      try {
        const outcome = await operation();
        if (!mountedRef.current) return true;
        await refreshList(undefined, { force: true });
        if (!mountedRef.current) return true;
        if (outcome && outcome.conflict) {
          publishFeedback({ tone: "warning", text: t("extensions.error.stale") });
          return false;
        }
        options?.onSuccess?.();
        if (options?.successText) {
          publishFeedback({ tone: "success", text: options.successText });
        }
        return true;
      } catch (cause: unknown) {
        if (!mountedRef.current) return false;
        if (isHostExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
          setInstallOpen(false);
          selectedRefCurrent.current = null;
          setSelectedRef(null);
          return false;
        }
        const message = formatManagementError(cause, t);
        if (isHostExtensionRevisionConflictError(cause)) {
          void refreshList(undefined, { force: true });
        } else {
          options?.onFailure?.();
        }
        publishFeedback({ tone: "danger", text: t("extensions.actionFailed", { message }) });
        return false;
      } finally {
        pendingByIdRef.current.delete(extensionId);
        if (mountedRef.current) setPendingById(new Map(pendingByIdRef.current));
      }
    },
    [refreshList, t],
  );

  const runManualInstall = useCallback(
    async (
      operation: () => Promise<void>,
      options: { readonly successText: string; readonly onSuccess?: () => void },
    ): Promise<boolean> => {
      if (recoveringRef.current || manualInstallingRef.current) return false;
      manualInstallingRef.current = true;
      setManualInstalling(true);
      setInstallError(null);
      try {
        await operation();
        if (!mountedRef.current) return true;
        await refreshList(undefined, { force: true });
        if (!mountedRef.current) return true;
        setFeedback({ tone: "success", text: options.successText });
        options.onSuccess?.();
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
        setInstallError(t("extensions.actionFailed", { message }));
        return false;
      } finally {
        manualInstallingRef.current = false;
        if (mountedRef.current) setManualInstalling(false);
      }
    },
    [refreshList, t],
  );

  const listData = listView.kind === "ready" ? listView.data : null;
  const extensions = useMemo(() => listData?.extensions ?? [], [listData]);
  const diagnostics = useMemo(() => listData?.diagnostics ?? [], [listData]);

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
    for (const entry of market.entries) {
      for (const cat of entry.categories ?? []) present.add(cat);
    }
    return CATEGORY_ORDER.filter((cat) => present.has(cat));
  }, [market.entries]);

  useEffect(() => {
    if (
      activeView !== "all" &&
      activeView !== "installed" &&
      availableCategories.length > 0 &&
      !availableCategories.includes(activeView)
    ) {
      setActiveView("all");
    }
  }, [availableCategories, activeView]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isInstalledView = activeView === "installed";
  const selectedCategory: DesktopExtensionCategory | null =
    activeView !== "all" && activeView !== "installed" ? activeView : null;

  const filteredInstalled = useMemo(() => {
    return extensions.filter((item) => {
      if (!matchesCapabilityFilter(capabilityFilter, itemCapabilities(item), itemTargets(item))) {
        return false;
      }
      return matchesInstalledSearch(item, normalizedQuery, t);
    });
  }, [extensions, capabilityFilter, normalizedQuery, t]);

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

  const isDefaultMarketplaceHome =
    activeView === "all" && normalizedQuery === "" && capabilityFilter === "all";

  const { featuredEntries, communityEntries } = useMemo(() => {
    if (!isDefaultMarketplaceHome) {
      return {
        featuredEntries: [] as readonly HostExtensionCatalogEntry[],
        communityEntries: filteredMarket,
      };
    }
    const hasExplicitFeatured = filteredMarket.some((entry) => entry.featured === true);
    if (!hasExplicitFeatured && filteredMarket.length <= 3) {
      return {
        featuredEntries: [] as readonly HostExtensionCatalogEntry[],
        communityEntries: filteredMarket,
      };
    }
    const featured = selectFeaturedCatalogEntries(filteredMarket, 3);
    const featuredIds = new Set(featured.map((entry) => entry.id));
    const community = filteredMarket.filter((entry) => !featuredIds.has(entry.id));
    return { featuredEntries: featured, communityEntries: community };
  }, [isDefaultMarketplaceHome, filteredMarket]);

  const detailTarget: DetailModalTarget | null = useMemo(() => {
    if (selectedRef === null) return null;
    const item = installedById.get(selectedRef.id);
    const catalog = catalogById.get(selectedRef.id);
    if (!item && !catalog) return null;
    return { item, catalog };
  }, [selectedRef, installedById, catalogById]);

  const hasPendingTasks = pendingById.size > 0 || manualInstalling || recovering;

  const handleToggle = (item: HostExtensionListItem, enabled: boolean) => {
    if (recoveringRef.current || pendingByIdRef.current.has(item.id)) return;
    const previousEnabled = item.enabled;
    const name = hostDisplayName(item, contentLocale, catalogById.get(item.id));
    // Optimistically flip toggle state in UI for crisp responsiveness.
    setListView((prev) => {
      if (prev.kind !== "ready") return prev;
      return {
        kind: "ready",
        data: {
          ...prev.data,
          extensions: prev.data.extensions.map((entry) =>
            entry.id === item.id ? { ...entry, enabled } : entry,
          ),
        },
      };
    });
    void runExtensionMutation(
      item.id,
      "toggle",
      () => {
        const task = toggleQueueRef.current.then(async () => {
          const expectedRevision = configRevisionRef.current;
          const res = enabled
            ? await hostExtensionsApi.enable({ id: item.id, expectedRevision })
            : await hostExtensionsApi.disable({ id: item.id, expectedRevision });
          listRequestTokenRef.current += 1;
          if (res.state === "saved") {
            configRevisionRef.current = res.configuration.revision;
            return undefined;
          }
          configRevisionRef.current = res.revision;
          return { conflict: true };
        });
        toggleQueueRef.current = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      },
      {
        successText: t(enabled ? "extensions.savedEnabled" : "extensions.savedDisabled", { name }),
        onFailure: () => {
          setListView((prev) => {
            if (prev.kind !== "ready") return prev;
            return {
              kind: "ready",
              data: {
                ...prev.data,
                extensions: prev.data.extensions.map((entry) =>
                  entry.id === item.id ? { ...entry, enabled: previousEnabled } : entry,
                ),
              },
            };
          });
        },
      },
    );
  };

  const handleInstallMarket = (entry: HostExtensionCatalogEntry) => {
    const name = resolveLocalizedExtensionText(entry.name, contentLocale);
    void runExtensionMutation(
      entry.id,
      "install",
      async () => {
        await hostExtensionsApi.install({
          source: {
            type: "catalog",
            id: entry.id,
          },
        });
      },
      {
        successText: t("extensions.installedSuccess", { name }),
      },
    );
  };

  const handleUpdate = (item: HostExtensionValidItem, entry: HostExtensionCatalogEntry) => {
    const name = hostDisplayName(item, contentLocale, entry);
    void runExtensionMutation(
      item.id,
      "update",
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
    void runExtensionMutation(
      item.id,
      "uninstall",
      async () => {
        await hostExtensionsApi.uninstall({ id: item.id });
      },
      {
        successText: t("extensions.uninstalledSuccess", { name }),
        onSuccess: () => {
          if (!hasCatalog && selectedRefCurrent.current?.id === item.id) {
            selectedRefCurrent.current = null;
            setSelectedRef(null);
          }
          setModalFeedback((prev) => (prev?.extensionId === item.id ? null : prev));
        },
      },
    );
  };

  const handleRecover = () => {
    if (recoveringRef.current || pendingByIdRef.current.size > 0 || manualInstallingRef.current)
      return;
    recoveringRef.current = true;
    setRecovering(true);
    setFeedback(null);
    void (async () => {
      try {
        const res = await hostExtensionsApi.recover({
          expectedRevision: configRevisionRef.current,
        });
        if (!mountedRef.current) return;
        listRequestTokenRef.current += 1;
        configRevisionRef.current =
          res.state === "saved" ? res.configuration.revision : res.revision;
        await refreshList(undefined, { force: true });
        if (!mountedRef.current) return;
        if (res.state === "revision-conflict") {
          setFeedback({ tone: "warning", text: t("extensions.error.stale") });
          return;
        }
        setFeedback({ tone: "success", text: t("extensions.recover.success") });
        setRecoverOpen(false);
      } catch (cause: unknown) {
        if (!mountedRef.current) return;
        if (isHostExtensionAuthDisabledError(cause)) {
          setListView({ kind: "disabled" });
          setInstallOpen(false);
          selectedRefCurrent.current = null;
          setSelectedRef(null);
          return;
        }
        const message = formatManagementError(cause, t);
        if (isHostExtensionRevisionConflictError(cause)) {
          void refreshList(undefined, { force: true });
        }
        setFeedback({ tone: "danger", text: t("extensions.actionFailed", { message }) });
      } finally {
        recoveringRef.current = false;
        if (mountedRef.current) setRecovering(false);
      }
    })();
  };

  const handleManualInstall = (request: InstallWebExtensionRequest): Promise<boolean> => {
    if (request.kind === "zip") {
      return runManualInstall(
        async () => {
          await hostExtensionsApi.uploadZip(request.file);
        },
        {
          successText: t("extensions.installedSuccess", { name: request.file.name }),
          onSuccess: () => {
            setInstallOpen(false);
            setActiveView("installed");
          },
        },
      );
    }
    if (request.kind === "github") {
      return runManualInstall(
        async () => {
          await hostExtensionsApi.install({ source: request.source });
        },
        {
          successText: t("extensions.installedSuccess", { name: request.source.repository }),
          onSuccess: () => {
            setInstallOpen(false);
            setActiveView("installed");
          },
        },
      );
    }
    return runManualInstall(
      async () => {
        await hostExtensionsApi.install({
          source: { type: "localDir", localDir: request.localDir },
        });
      },
      {
        successText: t("extensions.installedSuccess", { name: request.localDir }),
        onSuccess: () => {
          setInstallOpen(false);
          setActiveView("installed");
        },
      },
    );
  };

  const handleRefreshAll = () => {
    if (recovering) return;
    setFeedback(null);
    void refreshList(undefined, { force: true });
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

  const canMutate = listView.kind === "ready";
  const filterActive = capabilityFilter !== "all";

  const renderMarketCard = (entry: HostExtensionCatalogEntry, layout: "featured" | "row") => {
    const displayName = resolveLocalizedExtensionText(entry.name, contentLocale);
    const description = resolveOptionalLocalizedText(entry.description, contentLocale);
    const installed = installedById.get(entry.id);
    const validInstalled = installed?.state === "valid" ? installed : undefined;
    const updateAvailable = hasHostCatalogUpdate(installed, entry);
    const entryAction = pendingById.get(entry.id) ?? null;
    const isEntryBusy = entryAction !== null;
    const isInstalling = entryAction === "install";
    const isUpdating = entryAction === "update";
    const controlsDisabled = isEntryBusy || recovering || !canMutate;
    const desktopOnly = entry.targets.includes("desktop") && !entry.targets.includes("web");

    const actionButton = !installed ? (
      <button
        type="button"
        className={css.quietInstallButton}
        disabled={controlsDisabled}
        aria-busy={isInstalling}
        onClick={() => handleInstallMarket(entry)}
      >
        {t(isInstalling ? "extensions.installing" : "extensions.install")}
      </button>
    ) : updateAvailable && validInstalled ? (
      <button
        type="button"
        className={css.updateButton}
        disabled={controlsDisabled}
        aria-busy={isUpdating}
        onClick={() => handleUpdate(validInstalled, entry)}
      >
        {t(isUpdating ? "extensions.updating" : "extensions.update")}
      </button>
    ) : (
      <button
        type="button"
        className={css.installedButton}
        disabled={isEntryBusy || recovering}
        title={t("extensions.installedBadge")}
        aria-label={t("extensions.installedBadge")}
        onClick={() => {
          setModalFeedback(null);
          setSelectedRef({ kind: "market", id: entry.id });
        }}
      >
        <InstalledCheckIcon />
        <span>{t("extensions.installedBadge")}</span>
      </button>
    );

    return (
      <WebExtensionCard
        key={entry.id}
        cardKey={`market:${entry.id}`}
        extensionId={entry.id}
        cardKind="market"
        layout={layout}
        displayName={displayName}
        description={description}
        iconUrl={resolveHostIconUrl(installed, entry)}
        author={entry.author}
        version={entry.version}
        downloads={entry.downloads}
        trustTier={entry.trustTier}
        categories={entry.categories}
        incompatiblePlatformLabel={
          desktopOnly ? t("extensions.platform.desktopOnlyShort") : undefined
        }
        busy={isEntryBusy}
        contentLocale={contentLocale}
        t={t}
        actionControl={actionButton}
        onOpenDetails={() => {
          setModalFeedback(null);
          setSelectedRef({ kind: "market", id: entry.id });
        }}
      />
    );
  };

  const renderInstalledCard = (item: HostExtensionListItem) => {
    const catalogEntry = catalogById.get(item.id);
    const validItem = item.state === "valid" ? item : undefined;
    const displayName = hostDisplayName(item, contentLocale, catalogEntry);
    const description = hostDescription(item, contentLocale, catalogEntry);
    const itemAction = pendingById.get(item.id) ?? null;
    const isItemBusy = itemAction !== null;
    const isUpdating = itemAction === "update";
    const controlsDisabled = isItemBusy || recovering;
    const blocked = isHostToggleBlocked(item);
    const targets = itemTargets(item);
    const desktopOnly = targets.includes("desktop") && !targets.includes("web");

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
            tone: item.state === "incompatible" ? ("warning" as const) : ("danger" as const),
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

    const canOpenPage = Boolean(validItem && validItem.enabled && validItem.manifest.page);

    return (
      <WebExtensionCard
        key={item.id}
        cardKey={`host:${item.id}`}
        extensionId={item.id}
        cardKind="installed"
        layout="row"
        displayName={displayName}
        description={description}
        iconUrl={resolveHostIconUrl(item, catalogEntry)}
        author={validItem?.manifest.author ?? catalogEntry?.author}
        version={validItem?.manifest.version}
        downloads={catalogEntry?.downloads}
        trustTier={catalogEntry?.trustTier}
        categories={validItem?.manifest.categories ?? catalogEntry?.categories}
        incompatiblePlatformLabel={
          desktopOnly ? t("extensions.platform.desktopOnlyShort") : undefined
        }
        statusDot={statusDot}
        update={
          validItem && catalogEntry && hasHostCatalogUpdate(validItem, catalogEntry)
            ? {
                label: t("extensions.updateVersionCue", {
                  version: catalogEntry.version.replace(/^v/u, ""),
                }),
                action: (
                  <button
                    type="button"
                    className={css.updateButton}
                    disabled={controlsDisabled}
                    aria-busy={isUpdating}
                    onClick={() => handleUpdate(validItem, catalogEntry)}
                  >
                    {t(isUpdating ? "extensions.updating" : "extensions.update")}
                  </button>
                ),
              }
            : undefined
        }
        attention={attention}
        busy={isItemBusy}
        contentLocale={contentLocale}
        t={t}
        secondaryAction={
          canOpenPage && validItem ? (
            <button
              type="button"
              className={css.openPageButton}
              data-action="open-page"
              data-extension-id={validItem.id}
              disabled={controlsDisabled}
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
            disabled={controlsDisabled || blocked}
            title={blocked ? t("extensions.toggleBlockedInvalid") : undefined}
            onChange={(next) => handleToggle(item, next)}
          />
        }
        onOpenDetails={() => {
          setModalFeedback(null);
          setSelectedRef({ kind: "installed", id: item.id });
        }}
      />
    );
  };

  return (
    <div
      className={css.page}
      data-web-extensions
      data-has-page-tabs={hasPageTabs ? "true" : undefined}
    >
      {/* Clean editorial header: title + 1-line subtitle on left; direct Create & Import actions on right */}
      <header className={css.heroHeader}>
        <div className={css.heroCopy}>
          {!hasPageTabs && <h1 className={css.title}>{t("extensions.center")}</h1>}
          <p className={css.subtitle}>{t("extensions.subtitle")}</p>
        </div>
        {listView.kind !== "disabled" && (
          <div className={css.heroActions}>
            <button
              type="button"
              className={css.createHeaderButton}
              data-action="open-create"
              disabled={recovering}
              onClick={() => setCreateOpen(true)}
            >
              <IconSparkleRegular size={13} />
              <span>{t("extensions.create.button")}</span>
            </button>
            <button
              type="button"
              className={css.importHeaderButton}
              data-action="open-import"
              disabled={!canMutate || recovering || manualInstalling}
              onClick={() => {
                setInstallError(null);
                setInstallOpen(true);
              }}
            >
              <UploadArrowIcon />
              <span>{t("extensions.add")}</span>
            </button>
          </div>
        )}
      </header>

      {/* Single sticky bar: All + Installed | categories on left; Search + Filter + More on right */}
      {listView.kind !== "disabled" && (
        <div className={css.stickyBar}>
          <nav className={css.navTabs} role="tablist" aria-label={t("extensions.tabListLabel")}>
            <button
              type="button"
              role="tab"
              className={css.navTab}
              aria-selected={activeView === "all"}
              onClick={() => setActiveView("all")}
            >
              {t("extensions.tabAll")}
            </button>
            <button
              type="button"
              role="tab"
              className={`${css.navTab} ${css.navTabInstalled}`}
              aria-selected={activeView === "installed"}
              aria-description={
                hasInstalledUpdates ? t("extensions.installedUpdatesAvailable") : undefined
              }
              onClick={() => setActiveView("installed")}
            >
              <span>
                {listView.kind === "ready"
                  ? t("extensions.tabInstalled", { count: String(extensions.length) })
                  : t("extensions.installed")}
              </span>
              {hasInstalledUpdates && <span className={css.tabUpdateDot} aria-hidden="true" />}
            </button>
            {availableCategories.length > 0 && (
              <span className={css.navDivider} aria-hidden="true" />
            )}
            {availableCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                className={css.navTab}
                aria-selected={activeView === cat}
                onClick={() => setActiveView(cat)}
              >
                {categoryLabelForLocale(cat, contentLocale)}
              </button>
            ))}
          </nav>

          <div className={css.barActions}>
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

            {/* Technical capability & platform filter popover */}
            <div ref={filterWrapRef} className={css.menuAnchor}>
              <button
                type="button"
                className={css.filterButton}
                data-active={filterActive ? "true" : undefined}
                aria-haspopup="menu"
                aria-expanded={filterMenuOpen}
                aria-label={t("extensions.filter.label")}
                title={t("extensions.filter.label")}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setFilterMenuOpen((open) => !open);
                }}
              >
                <SlidersIcon />
                <span>
                  {filterActive
                    ? capabilityFilterLabel(capabilityFilter, t)
                    : t("extensions.filterButton")}
                </span>
                {filterActive && <span className={css.filterActiveDot} aria-hidden="true" />}
                <IconChevronDownOutlineRegular size={11} />
              </button>

              {filterMenuOpen && (
                <div
                  className={`${css.menu} ${css.menuCompact}`}
                  role="menu"
                  aria-label={t("extensions.filter.label")}
                  data-capability-filters
                >
                  {CAPABILITY_FILTER_ORDER.map((filter) => {
                    const selected = capabilityFilter === filter;
                    return (
                      <button
                        key={filter}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        data-capability-filter={filter}
                        className={`${css.menuItem} ${css.menuItemRadio}`}
                        onClick={() => {
                          setCapabilityFilter(filter);
                          setFilterMenuOpen(false);
                        }}
                      >
                        <span>{capabilityFilterLabel(filter, t)}</span>
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

            {/* Quiet More ("...") menu: language, refresh, recover, legacy recovery */}
            <div ref={moreWrapRef} className={`${css.menuAnchor} ${css.moreMenuAnchor}`}>
              <button
                type="button"
                className={css.iconButton}
                data-action="more-menu"
                aria-label={t("extensions.moreActions")}
                title={t("extensions.moreActions")}
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                disabled={recovering}
                onClick={() => {
                  setFilterMenuOpen(false);
                  setMoreMenuOpen((open) => !open);
                }}
              >
                <IconEllipsisOutlineRegular size={16} />
              </button>

              {moreMenuOpen && (
                <div className={css.menu} role="menu" aria-label={t("extensions.moreActions")}>
                  <div className={css.menuHeading}>{t("extensions.languageMenuLabel")}</div>
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
                          setMoreMenuOpen(false);
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
                  <div className={css.menuDivider} role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className={css.menuItem}
                    disabled={recovering || market.loading}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleRefreshAll();
                    }}
                  >
                    <IconRefreshOutlineRegular size={13} />
                    <span>{t("extensions.refreshMarket")}</span>
                  </button>
                  {canMutate && (
                    <>
                      <div className={css.menuDivider} role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className={`${css.menuItem} ${css.menuItemDanger}`}
                        disabled={hasPendingTasks}
                        onClick={() => {
                          setMoreMenuOpen(false);
                          setRecoverOpen(true);
                        }}
                      >
                        {t("extensions.recover.action")}
                      </button>
                    </>
                  )}
                  <div className={css.menuDivider} role="separator" />
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
        </div>
      )}

      {/* Auth / Host unavailable states */}
      {listView.kind === "disabled" ? (
        <div className={css.emptyCard} data-web-extensions-notice="disabled">
          <div className={css.emptyCopy}>
            <p className={css.emptyDesc}>{t("extensions.authDisabled")}</p>
          </div>
        </div>
      ) : listView.kind === "unavailable" && isInstalledView ? (
        <div className={css.emptyCard} data-web-extensions-notice="unavailable">
          <div className={css.emptyCopy}>
            <p className={css.emptyDesc}>{t("extensions.unavailable")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshList(undefined, { force: true })}
          >
            {t("extensions.retry")}
          </Button>
        </div>
      ) : listView.kind === "failed" && isInstalledView ? (
        <div className={css.banner} data-tone="danger" role="alert">
          <span>{t("extensions.loadFailed", { message: listView.message })}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshList(undefined, { force: true })}
          >
            {t("extensions.retry")}
          </Button>
        </div>
      ) : (
        <>
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

          {isInstalledView ? (
            listView.kind === "loading" ? (
              <InstalledSkeleton />
            ) : extensions.length === 0 ? (
              <div className={css.emptyCard}>
                <div className={css.emptyCopy}>
                  <h3 className={css.emptyTitle}>{t("extensions.empty")}</h3>
                  <p className={css.emptyDesc}>{t("extensions.emptyHint")}</p>
                </div>
                <div className={css.emptyActions}>
                  <Button variant="primary" size="sm" onClick={() => setActiveView("all")}>
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
                  }}
                >
                  {t("extensions.clearFilters")}
                </Button>
              </div>
            ) : (
              <div className={css.sections}>
                {groupedInstalled.map((group) => (
                  <section key={group.id} className={css.section} data-extension-group={group.id}>
                    <h2 className={css.sectionTitle}>
                      <span>
                        {group.id === "attention"
                          ? t("extensions.group.attention")
                          : t("extensions.section.installed")}
                      </span>
                      <span className={css.sectionCount}>{group.items.length}</span>
                    </h2>
                    <div className={css.rowGrid}>
                      {group.items.map((item) => renderInstalledCard(item))}
                    </div>
                  </section>
                ))}
              </div>
            )
          ) : (
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
                <MarketSkeleton />
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
                      setActiveView("all");
                    }}
                  >
                    {t("extensions.clearFilters")}
                  </Button>
                </div>
              ) : (
                <div className={css.sections}>
                  {featuredEntries.length > 0 && (
                    <section className={css.section} data-market-section="featured">
                      <h2 className={css.sectionTitle}>
                        <span>{t("extensions.section.featured")}</span>
                        <span className={css.sectionCount}>{featuredEntries.length}</span>
                      </h2>
                      <div className={css.featuredGrid}>
                        {featuredEntries.map((entry) => renderMarketCard(entry, "featured"))}
                      </div>
                    </section>
                  )}

                  {communityEntries.length > 0 && (
                    <section className={css.section} data-market-section="community">
                      <h2 className={css.sectionTitle}>
                        <span>
                          {selectedCategory !== null
                            ? categoryLabelForLocale(selectedCategory, contentLocale)
                            : t("extensions.section.community")}
                        </span>
                        <span className={css.sectionCount}>{communityEntries.length}</span>
                      </h2>
                      <div className={css.rowGrid}>
                        {communityEntries.map((entry) => renderMarketCard(entry, "row"))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <InstallWebExtensionDialog
        t={t}
        open={installOpen}
        busy={manualInstalling}
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
        pendingAction={selectedRef ? (pendingById.get(selectedRef.id) ?? null) : null}
        globalBusy={recovering}
        feedback={
          modalFeedback && selectedRef && modalFeedback.extensionId === selectedRef.id
            ? modalFeedback
            : null
        }
        locale={contentLocale}
        t={t}
        onClose={() => {
          setSelectedRef(null);
          setModalFeedback(null);
        }}
        onToggle={(item, enabled) => handleToggle(item, enabled)}
        onInstallMarket={(entry) => handleInstallMarket(entry)}
        onUpdate={(item, entry) => handleUpdate(item, entry)}
        onUninstall={handleUninstall}
        onOpenPage={selectPage}
      />

      <Modal
        open={recoverOpen}
        onClose={() => {
          if (!recovering) setRecoverOpen(false);
        }}
        title={t("extensions.recover.title")}
        closeLabel={t("extensions.close")}
        className={css.recoverDialog}
        footer={
          <div className={css.recoverFooter}>
            <Button variant="outline" disabled={recovering} onClick={() => setRecoverOpen(false)}>
              {t("extensions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={hasPendingTasks}
              aria-busy={recovering}
              onClick={handleRecover}
            >
              {t(recovering ? "extensions.recover.running" : "extensions.recover.confirm")}
            </Button>
          </div>
        }
      >
        <p className={css.recoverBody}>{t("extensions.recover.description")}</p>
      </Modal>
    </div>
  );
}
