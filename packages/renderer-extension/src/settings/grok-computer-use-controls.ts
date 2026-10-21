import type { GrokComputerUseSettings } from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch } from "./preference-ui.js";

export function createGrokComputerUseControls(
  document: Document,
  messages: RendererSettingsMessages,
  settings: {
    get(): Promise<GrokComputerUseSettings>;
    set(enabled: boolean): Promise<GrokComputerUseSettings>;
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-grok-computer-use";
  section.dataset.grokComputerUse = "true";

  const header = document.createElement("div");
  header.className = "settings-grok-computer-use__header";
  const copy = document.createElement("div");
  copy.className = "settings-grok-computer-use__copy";
  const title = document.createElement("h3");
  title.className = "settings-grok-computer-use__title";
  title.id = "grok-computer-use-title";
  title.textContent = messages.grokComputerUseTitle;
  const description = document.createElement("p");
  description.className = "settings-grok-computer-use__description";
  description.id = "grok-computer-use-description";
  description.textContent = messages.grokComputerUseDescription;
  copy.append(title, description);
  const input = createPreferenceSwitch(
    document,
    "grok-computer-use-enabled",
    "grok-computer-use-description grok-computer-use-help grok-computer-use-status",
  );
  input.setAttribute("aria-labelledby", title.id);
  input.setAttribute("aria-label", messages.grokComputerUseLabel);
  header.append(copy, input);

  const help = document.createElement("p");
  help.className = "settings-grok-computer-use__help";
  help.id = "grok-computer-use-help";
  help.textContent = messages.grokComputerUseHelp;

  const status = document.createElement("p");
  status.className = "settings-grok-computer-use__status";
  status.id = "grok-computer-use-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  section.append(header, help, status);

  let busy = true;
  let loaded = false;
  let last: GrokComputerUseSettings | undefined;
  const show = (value: GrokComputerUseSettings) => {
    last = value;
    input.checked = value.enabled;
    input.disabled = busy || !loaded || (!value.available && !value.enabled);
    if (!value.available) {
      status.dataset.state = "unavailable";
      status.textContent = value.unavailableReason ?? messages.grokComputerUseUnavailable;
      return;
    }
    status.dataset.state = value.enabled ? "on" : "off";
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
