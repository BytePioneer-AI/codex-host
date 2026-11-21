import type { RendererConnectionDiagnostics } from "./connections-page.js";
import type { HarnessVersionPanel } from "./harness-version-panel.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

interface UpdateBatch {
  running: boolean;
  total: number;
  succeeded: number;
  failed: number;
}

interface BatchStore {
  readonly batches: Map<string, UpdateBatch>;
  readonly listeners: Set<() => void>;
}

const sharedBatchStores = new WeakMap<RendererConnectionDiagnostics, BatchStore>();

function getBatchStore(diagnostics: RendererConnectionDiagnostics | null): BatchStore {
  if (!diagnostics) {
    return { batches: new Map(), listeners: new Set() };
  }
  let store = sharedBatchStores.get(diagnostics);
  if (!store) {
    store = { batches: new Map(), listeners: new Set() };
    sharedBatchStores.set(diagnostics, store);
  }
  return store;
}

/** Batches outlive individual page mounts so reopening Settings preserves active progress. */
export function createConnectionUpdates(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  onChange: () => void,
  diagnostics: RendererConnectionDiagnostics | null = null,
) {
  const store = getBatchStore(diagnostics);
  const notify = (): void => {
    for (const listener of [...store.listeners]) listener();
  };
  if (!signal.aborted) {
    const listener = (): void => {
      if (!signal.aborted) onChange();
    };
    store.listeners.add(listener);
    signal.addEventListener(
      "abort",
      () => {
        store.listeners.delete(listener);
      },
      { once: true },
    );
  }

  const eligible = (panels: readonly HarnessVersionPanel[]) =>
    panels.filter((panel) => panel.state?.updateAvailable && panel.state.canUpdate);

  const start = async (hostId: string, panels: readonly HarnessVersionPanel[]): Promise<void> => {
    if (signal.aborted || store.batches.get(hostId)?.running) return;
    const targets = eligible(panels);
    if (!targets.length) return;
    const batch: UpdateBatch = { running: true, total: targets.length, succeeded: 0, failed: 0 };
    store.batches.set(hostId, batch);
    notify();
    await Promise.all(
      targets.map(async (panel) => {
        try {
          if (await panel.update()) batch.succeeded++;
          else batch.failed++;
        } catch {
          batch.failed++;
        }
        notify();
      }),
    );
    batch.running = false;
    notify();
  };

  return {
    createControls(hostId: string, panels: readonly HarnessVersionPanel[]) {
      let currentHostId = hostId;
      let currentPanels = panels;
      let renderedLabel: string | null = null;
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "settings-command-button settings-command-button--secondary settings-connection-update-all";
      button.dataset.connectionAction = "update-all";
      button.title = messages.harnessUpdateAllDescription;
      button.addEventListener("click", () => {
        if (!button.disabled) void start(currentHostId, currentPanels);
      });
      const result = document.createElement("p");
      result.className = "settings-connection-update-result";
      result.setAttribute("role", "status");

      const update = (nextHostId: string, nextPanels: readonly HarnessVersionPanel[]): void => {
        currentHostId = nextHostId;
        currentPanels = nextPanels;
        const batch = store.batches.get(nextHostId);
        const count = eligible(nextPanels).length;
        button.disabled = signal.aborted || Boolean(batch?.running) || !count;
        const label = batch?.running
          ? `${messages.harnessUpdateAllProgress} ${batch.succeeded + batch.failed}/${batch.total}`
          : count
            ? `${messages.harnessUpdateAll} (${count})`
            : messages.harnessUpdateAll;
        if (renderedLabel !== label) {
          renderedLabel = label;
          button.replaceChildren(createRendererSettingsIcon("download", 15), label);
        }
        const hidden = !batch || batch.running;
        result.hidden = hidden;
        const resultText =
          batch && !batch.running
            ? messages.harnessUpdateAllResult
                .replace("{succeeded}", String(batch.succeeded))
                .replace("{failed}", String(batch.failed))
            : "";
        if (result.textContent !== resultText) {
          result.textContent = resultText;
        }
      };

      update(hostId, panels);
      return { button, result, update };
    },
  };
}
