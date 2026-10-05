import {
  harnessConnectionModeSchema,
  type HarnessConnectionMode,
  type HarnessLaunchSettings,
} from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";

export function createHarnessConnectionControls(
  document: Document,
  messages: RendererSettingsMessages,
  settings: {
    get(): Promise<HarnessLaunchSettings>;
    set(mode: HarnessConnectionMode): Promise<HarnessLaunchSettings>;
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-harness-launch";
  section.dataset.harnessConnection = "deepseek-harness";
  const label = document.createElement("label");
  label.textContent = messages.connectionModeLabel;
  const select = document.createElement("select");
  select.setAttribute("aria-label", messages.connectionModeLabel);
  for (const mode of harnessConnectionModeSchema.options) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    select.append(option);
  }
  select.value = "web";
  select.disabled = true;
  label.append(select);
  const help = document.createElement("p");
  help.textContent = messages.connectionModeHelp;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = messages.launchPathLoading;
  section.append(label, help, status);
  let savedMode: HarnessConnectionMode = "web";
  const show = (value: HarnessLaunchSettings) => {
    savedMode = value.connectionMode ?? "web";
    select.value = savedMode;
    status.textContent = value.restartRequired ? messages.launchPathRestart : "";
  };
  select.addEventListener("change", () => {
    if (select.disabled) return;
    const mode = harnessConnectionModeSchema.parse(select.value);
    select.disabled = true;
    status.textContent = messages.launchPathSaving;
    void settings
      .set(mode)
      .then(show)
      .catch(() => {
        select.value = savedMode;
        status.textContent = messages.connectionModeSaveError;
      })
      .finally(() => {
        select.disabled = false;
      });
  });
  void settings
    .get()
    .then((value) => {
      show(value);
      select.disabled = false;
    })
    .catch(() => {
      status.textContent = messages.launchPathLoadError;
    });
  return section;
}
