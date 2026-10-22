import type { GrokComputerUseSet, GrokComputerUseSettings } from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch } from "./preference-ui.js";

export function createGrokComputerUseControls(
  document: Document,
  messages: RendererSettingsMessages,
  settings: {
    get(): Promise<GrokComputerUseSettings>;
    set(update: GrokComputerUseSet): Promise<GrokComputerUseSettings>;
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

  const browserHeader = document.createElement("div");
  browserHeader.className =
    "settings-grok-computer-use__header settings-grok-computer-use__browser";
  const browserCopy = document.createElement("div");
  browserCopy.className = "settings-grok-computer-use__copy";
  const browserTitle = document.createElement("h3");
  browserTitle.className = "settings-grok-computer-use__title";
  browserTitle.id = "grok-browser-title";
  browserTitle.textContent = messages.grokBrowserTitle;
  const browserDescription = document.createElement("p");
  browserDescription.className = "settings-grok-computer-use__description";
  browserDescription.id = "grok-browser-description";
  browserDescription.textContent = messages.grokBrowserDescription;
  browserCopy.append(browserTitle, browserDescription);
  const browserInput = createPreferenceSwitch(
    document,
    "grok-browser-enabled",
    "grok-browser-description grok-browser-help grok-browser-status",
  );
  browserInput.setAttribute("aria-labelledby", browserTitle.id);
  browserInput.setAttribute("aria-label", messages.grokBrowserLabel);
  browserHeader.append(browserCopy, browserInput);
  const browserHelp = document.createElement("p");
  browserHelp.className = "settings-grok-computer-use__help";
  browserHelp.id = "grok-browser-help";
  browserHelp.textContent = messages.grokBrowserHelp;
  const browserStatus = document.createElement("p");
  browserStatus.className = "settings-grok-computer-use__status";
  browserStatus.id = "grok-browser-status";
  browserStatus.setAttribute("role", "status");
  browserStatus.setAttribute("aria-live", "polite");
  section.append(header, help, status, browserHeader, browserHelp, browserStatus);

  let busy = true;
  let loaded = false;
  let last: GrokComputerUseSettings | undefined;
  const show = (value: GrokComputerUseSettings) => {
    last = value;
    input.checked = value.enabled;
    input.disabled = busy || !loaded || (!value.available && !value.enabled);
    const browserOn = value.browser === true;
    const browserFiles = value.browserFilesPresent === true;
    browserInput.checked = browserOn;
    browserInput.disabled = busy || !loaded || (!browserFiles && !browserOn);
    if (!browserFiles) {
      browserStatus.dataset.state = "unavailable";
      browserStatus.textContent = value.browserUnavailableReason ?? messages.grokBrowserUnavailable;
    } else if (value.browserAvailable !== true) {
      browserStatus.dataset.state = browserOn ? "unavailable" : "off";
      browserStatus.textContent = browserOn
        ? (value.browserUnavailableReason ?? messages.grokBrowserBlocked)
        : messages.grokBrowserOff;
    } else {
      browserStatus.dataset.state = browserOn ? "on" : "off";
      browserStatus.textContent = browserOn ? messages.grokBrowserOn : messages.grokBrowserOff;
    }
    if (value.applyFailed) {
      status.dataset.state = "unavailable";
      status.textContent = value.applyError ?? messages.grokComputerUseApplyFailed;
      return;
    }
    if (!value.available) {
      status.dataset.state = "unavailable";
      status.textContent = value.unavailableReason ?? messages.grokComputerUseUnavailable;
      return;
    }
    status.dataset.state = value.enabled ? "on" : "off";
    status.textContent = value.enabled ? messages.grokComputerUseOn : messages.grokComputerUseOff;
  };
  const save = (update: GrokComputerUseSet, target: HTMLElement) => {
    if (busy || !loaded) return;
    busy = true;
    input.disabled = true;
    browserInput.disabled = true;
    target.textContent = messages.grokComputerUseSaving;
    void settings
      .set(update)
      .then((value) => {
        busy = false;
        show(value);
      })
      .catch(() => {
        busy = false;
        if (last) show(last);
        else {
          input.disabled = false;
          browserInput.disabled = false;
        }
        target.textContent = messages.grokComputerUseSaveError;
      });
  };
  input.addEventListener("change", () => save({ enabled: input.checked }, status));
  browserInput.addEventListener("change", () =>
    save({ browser: browserInput.checked }, browserStatus),
  );
  status.textContent = messages.grokComputerUseLoading;
  browserStatus.textContent = messages.grokBrowserOff;
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
      browserStatus.textContent = messages.grokComputerUseLoadError;
    });
  return section;
}
