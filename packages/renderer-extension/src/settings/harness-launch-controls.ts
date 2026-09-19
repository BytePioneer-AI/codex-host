import type { HarnessLaunchSettings } from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";

export function createHarnessLaunchControls(
  document: Document,
  messages: RendererSettingsMessages,
  agent: "workbuddy",
  settings: {
    get(): Promise<HarnessLaunchSettings>;
    set(path: string | null): Promise<HarnessLaunchSettings>;
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-harness-launch";
  section.dataset.harnessLaunch = agent;
  const label = document.createElement("label");
  label.textContent = messages.launchPathLabel;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = messages.launchPathPlaceholder;
  input.setAttribute("aria-label", messages.launchPathLabel);
  label.append(input);
  const help = document.createElement("p");
  help.textContent = messages.launchPathWorkbuddyHelp;
  const actions = document.createElement("div");
  actions.className = "settings-harness-launch__actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "settings-command-button";
  save.textContent = messages.launchPathSave;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-command-button settings-command-button--secondary";
  reset.textContent = messages.launchPathReset;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.append(save, reset);
  section.append(label, help, actions, status);

  let busy = true;
  let loaded = false;
  const controls = () => {
    input.disabled = busy || !loaded;
    save.disabled = busy || !loaded || !input.value.trim();
    reset.disabled = busy || !loaded;
  };
  const show = (value: HarnessLaunchSettings) => {
    input.value = value.path ?? "";
    status.textContent = value.restartRequired
      ? messages.launchPathRestart
      : value.path
        ? messages.launchPathSaved
        : messages.launchPathAutomatic;
  };
  const persist = async (value: string | null) => {
    if (busy || !loaded) return;
    busy = true;
    controls();
    status.textContent = messages.launchPathSaving;
    try {
      show(await settings.set(value));
    } catch {
      status.textContent = messages.launchPathSaveError;
    } finally {
      busy = false;
      controls();
    }
  };
  input.addEventListener("input", controls);
  save.addEventListener("click", () => {
    if (input.value.trim()) void persist(input.value.trim());
  });
  reset.addEventListener("click", () => {
    void persist(null);
  });
  controls();
  status.textContent = messages.launchPathLoading;
  void settings
    .get()
    .then((value) => {
      loaded = true;
      show(value);
    })
    .catch(() => {
      status.textContent = messages.launchPathLoadError;
    })
    .finally(() => {
      busy = false;
      controls();
    });
  return section;
}
