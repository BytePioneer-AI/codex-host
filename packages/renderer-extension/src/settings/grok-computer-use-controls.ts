import type { GrokComputerUseSettings } from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";

export function createGrokComputerUseControls(
  document: Document,
  messages: RendererSettingsMessages,
  settings: {
    get(): Promise<GrokComputerUseSettings>;
    set(enabled: boolean): Promise<GrokComputerUseSettings>;
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-harness-launch";
  section.dataset.grokComputerUse = "true";
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("aria-label", messages.grokComputerUseLabel);
  label.append(input, document.createTextNode(` ${messages.grokComputerUseLabel}`));
  const help = document.createElement("p");
  help.textContent = messages.grokComputerUseHelp;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  section.append(label, help, status);

  let busy = true;
  let loaded = false;
  let last: GrokComputerUseSettings | undefined;
  const show = (value: GrokComputerUseSettings) => {
    last = value;
    input.checked = value.enabled;
    input.disabled = busy || !loaded || (!value.available && !value.enabled);
    if (!value.available) {
      status.textContent = value.unavailableReason ?? messages.grokComputerUseUnavailable;
      return;
    }
    status.textContent = value.enabled ? messages.grokComputerUseOn : messages.grokComputerUseOff;
  };
  input.addEventListener("change", () => {
    if (busy || !loaded) return;
    busy = true;
    input.disabled = true;
    status.textContent = messages.grokComputerUseSaving;
    void settings
      .set(input.checked)
      .then((value) => {
        busy = false;
        show(value);
      })
      .catch(() => {
        busy = false;
        if (last) show(last);
        else input.disabled = false;
        status.textContent = messages.grokComputerUseSaveError;
      });
  });
  status.textContent = messages.grokComputerUseLoading;
  void settings
    .get()
    .then((value) => {
      loaded = true;
      busy = false;
      show(value);
    })
    .catch(() => {
      busy = false;
      status.textContent = messages.grokComputerUseLoadError;
    });
  return section;
}
