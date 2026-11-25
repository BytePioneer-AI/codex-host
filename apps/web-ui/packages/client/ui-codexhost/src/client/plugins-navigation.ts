import type { HostExtensionInstallation } from "@codexhost/shared-contracts";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";
import { hasHostCatalogUpdate } from "./web-extensions-helpers.ts";
import {
  hostExtensionsApi,
  isHostExtensionAuthDisabledError,
} from "./web-native-extension-management-api.ts";

export const PLUGINS_PANEL_ID = "codexhost-plugins" as MainPanelId;

interface PluginNavigationState {
  pages: readonly HostExtensionInstallation[];
  selectedPage: HostExtensionInstallation | null;
  hasUpdates: boolean;
}

/** Tracks available page activations, update availability, and selection in the Plugins workspace. */
export function createPluginsNavigation(doc: Document, selectPanel: () => void) {
  const store = createSnapshotStore<PluginNavigationState>({
    pages: [],
    selectedPage: null,
    hasUpdates: false,
  });
  let request: AbortController | undefined;
  let updateRequest: AbortController | undefined;
  let revision: number | undefined;

  const setHasUpdates = (hasUpdates: boolean) => {
    const current = store.getSnapshot();
    if (current.hasUpdates !== hasUpdates) {
      store.set({ ...current, hasUpdates });
    }
  };

  const reconcile = (pages: readonly HostExtensionInstallation[]) => {
    const { selectedPage, hasUpdates } = store.getSnapshot();
    store.set({
      pages,
      selectedPage: pages.find((page) => page.id === selectedPage?.id) ?? null,
      hasUpdates,
    });
  };

  const checkUpdates = async (): Promise<void> => {
    updateRequest?.abort();
    const controller = new AbortController();
    updateRequest = controller;
    try {
      const [list, catalog] = await Promise.all([
        hostExtensionsApi.list(controller.signal),
        hostExtensionsApi.catalog({ forceRefresh: false }, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const catalogById = new Map(catalog.extensions.map((entry) => [entry.id, entry]));
      const hasUpdates = list.extensions.some((item) =>
        hasHostCatalogUpdate(item, catalogById.get(item.id)),
      );
      setHasUpdates(hasUpdates);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isHostExtensionAuthDisabledError(error)) {
        setHasUpdates(false);
      }
    }
  };

  const sync = async (): Promise<void> => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    void checkUpdates();
    try {
      const snapshot = await hostExtensionsApi.snapshot(controller.signal);
      if (controller.signal.aborted) return;
      revision = snapshot.revision;
      // Snapshots contain only enabled, valid activations.
      reconcile(snapshot.extensions.filter(({ manifest }) => manifest.page !== undefined));
    } catch (error) {
      if (controller.signal.aborted) return;
      // Preserve the current page across transient transport failures.
      if (isHostExtensionAuthDisabledError(error)) {
        revision = undefined;
        reconcile([]);
        setHasUpdates(false);
      }
    }
  };

  const unsubscribe = subscribeHostExtensionEvents({
    document: doc,
    onExtensionsChanged: (nextRevision) => {
      if (nextRevision !== revision) void sync();
    },
    onReconnect: sync,
  });
  void sync();

  const selectPage = (page: HostExtensionInstallation | null) => {
    const { pages, selectedPage, hasUpdates } = store.getSnapshot();
    if (page === null) {
      if (selectedPage !== null) store.set({ pages, selectedPage: null, hasUpdates });
      return;
    }
    const existing = pages.find(({ id }) => id === page.id);
    if (existing?.activationId === page.activationId && existing.digest === page.digest) {
      if (selectedPage !== existing) store.set({ pages, selectedPage: existing, hasUpdates });
      return;
    }
    // A card may observe a new activation before the snapshot. Give the opened
    // page a tab immediately, then reconcile against the next Host snapshot.
    const next =
      existing === undefined
        ? [...pages, page]
        : pages.map((entry) => (entry === existing ? page : entry));
    store.set({ pages: next, selectedPage: page, hasUpdates });
    void sync();
  };

  return {
    store,
    selectPage,
    setHasUpdates,
    open: (page: HostExtensionInstallation | null = null) => {
      selectPanel();
      selectPage(page);
    },
    dispose: () => {
      unsubscribe();
      request?.abort();
      updateRequest?.abort();
    },
  };
}

export type PluginsNavigation = ReturnType<typeof createPluginsNavigation>;
