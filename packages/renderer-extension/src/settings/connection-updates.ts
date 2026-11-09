import type { HarnessVersionPanel } from "./harness-version-panel.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

interface UpdateBatch {
  running: boolean;
  total: number;
  succeeded: number;
  failed: number;
}

/** Batches retain their original Host and selection while the page is open. */
export function createConnectionUpdates(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  onChange: () => void,
) {
  const batches = new Map<string, UpdateBatch>();
  const eligible = (panels: readonly HarnessVersionPanel[]) =>
    panels.filter((panel) => panel.state?.updateAvailable && panel.state.canUpdate);

  const start = async (hostId: string, panels: readonly HarnessVersionPanel[]): Promise<void> => {
    if (signal.aborted || batches.get(hostId)?.running) return;
    const targets = eligible(panels);
    if (!targets.length) return;
    const batch: UpdateBatch = { running: true, total: targets.length, succeeded: 0, failed: 0 };
    batches.set(hostId, batch);
    onChange();
    await Promise.all(
      targets.map(async (panel) => {
        try {
          if (await panel.update()) batch.succeeded++;
          else batch.failed++;
        } catch {
          batch.failed++;
        }
        if (!signal.aborted) onChange();
      }),
    );
    batch.running = false;
    if (!signal.aborted) onChange();
  };

  return {
    createControls(hostId: string, panels: readonly HarnessVersionPanel[]) {
      const batch = batches.get(hostId);
      const count = eligible(panels).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "settings-command-button settings-command-button--secondary settings-connection-update-all";
      button.dataset.connectionAction = "update-all";
      button.disabled = signal.aborted || Boolean(batch?.running) || !count;
      button.title = messages.harnessUpdateAllDescription;
      const label = batch?.running
        ? `${messages.harnessUpdateAllProgress} ${batch.succeeded + batch.failed}/${batch.total}`
        : count
          ? `${messages.harnessUpdateAll} (${count})`
          : messages.harnessUpdateAll;
      button.append(createRendererSettingsIcon("download", 15), label);
      button.addEventListener("click", () => {
        if (!button.disabled) void start(hostId, panels);
      });
      const result = document.createElement("p");
      result.className = "settings-connection-update-result";
      result.setAttribute("role", "status");
      result.hidden = !batch || batch.running;
      if (batch && !batch.running) {
        result.textContent = messages.harnessUpdateAllResult
          .replace("{succeeded}", String(batch.succeeded))
          .replace("{failed}", String(batch.failed));
      }
      return { button, result };
    },
  };
}
