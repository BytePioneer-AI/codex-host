import type { HostExtensionInstallation } from "@codexhost/shared-contracts";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";
import {
  hostExtensionsApi,
  isHostExtensionAuthDisabledError,
} from "./web-native-extension-management-api.ts";

export const PLUGINS_PANEL_ID = "codexhost-plugins" as MainPanelId;

interface PluginNavigationState {
  pages: readonly HostExtensionInstallation[];
  selectedPage: HostExtensionInstallation | null;
}

/** Tracks available page activations and selection in the Plugins workspace. */
export function createPluginsNavigation(doc: Document, selectPanel: () => void) {
  const store = createSnapshotStore<PluginNavigationState>({ pages: [], selectedPage: null });
  let request: AbortController | undefined;
  let revision: number | undefined;

  const reconcile = (pages: readonly HostExtensionInstallation[]) => {
    const { selectedPage } = store.getSnapshot();
    store.set({
      pages,
      selectedPage: pages.find((page) => page.id === selectedPage?.id) ?? null,
    });
  };

  const sync = async (): Promise<void> => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
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
    const { pages, selectedPage } = store.getSnapshot();
    if (page === null) {
      if (selectedPage !== null) store.set({ pages, selectedPage: null });
      return;
    }
    const existing = pages.find(({ id }) => id === page.id);
    if (existing?.activationId === page.activationId && existing.digest === page.digest) {
      if (selectedPage !== existing) store.set({ pages, selectedPage: existing });
      return;
    }
    // A card may observe a new activation before the snapshot. Give the opened
    // page a tab immediately, then reconcile against the next Host snapshot.
    const next =
      existing === undefined
        ? [...pages, page]
        : pages.map((entry) => (entry === existing ? page : entry));
    store.set({ pages: next, selectedPage: page });
    void sync();
  };

  return {
    store,
    selectPage,
    open: (page: HostExtensionInstallation | null = null) => {
      selectPanel();
      selectPage(page);
    },
    dispose: () => {
      unsubscribe();
      request?.abort();
    },
  };
}

export type PluginsNavigation = ReturnType<typeof createPluginsNavigation>;
