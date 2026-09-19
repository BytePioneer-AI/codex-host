import type { HarnessConnectionState } from "@codexhost/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";

/** The form never receives a saved secret and never writes one to browser storage. */
export function createHarnessConnectionControls(
  document: Document,
  messages: RendererSettingsMessages,
  harnessId: string,
  settings: {
    get(): Promise<HarnessConnectionState>;
    set(secret: string | null, cwd?: string): Promise<HarnessConnectionState>;
  },
): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-harness-launch";
  section.dataset.harnessConnection = harnessId;
  section.hidden = true;
  const label = document.createElement("label");
  label.textContent = messages.nativeConnectionLabel;
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "new-password";
  input.spellcheck = false;
  input.maxLength = 8192;
  input.placeholder = messages.nativeConnectionPlaceholder;
  input.setAttribute("aria-label", messages.nativeConnectionLabel);
  label.append(input);
  const workspaceLabel = document.createElement("label");
  workspaceLabel.textContent = messages.nativeConnectionWorkspace;
  workspaceLabel.hidden = true;
  const workspace = document.createElement("input");
  workspace.type = "text";
  workspace.spellcheck = false;
  workspace.maxLength = 16_384;
  workspace.setAttribute("aria-label", messages.nativeConnectionWorkspace);
  workspaceLabel.append(workspace);
  const help = document.createElement("p");
  const actions = document.createElement("div");
  actions.className = "settings-harness-launch__actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "settings-command-button";
  save.textContent = messages.nativeConnectionSave;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "settings-command-button settings-command-button--secondary";
  clear.textContent = messages.nativeConnectionClear;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.append(save, clear);
  section.append(label, workspaceLabel, help, actions, status);
  let busy = true,
    configured = false,
    needsWorkspace = false;
  const controls = () => {
    input.disabled = busy;
    workspace.disabled = busy;
    save.disabled = busy || !input.value.trim() || (needsWorkspace && !workspace.value.trim());
    clear.disabled = busy || !configured;
  };
  const show = (state: HarnessConnectionState) => {
    section.hidden = !state.supported;
    if (!state.supported) return;
    configured = state.configured;
    needsWorkspace = state.cwd !== undefined;
    workspaceLabel.hidden = !needsWorkspace;
    workspace.value = state.cwd ?? "";
    help.textContent = state.description;
    status.textContent = state.restartRequired
      ? messages.launchPathRestart
      : state.configured
        ? messages.nativeConnectionConfigured
        : messages.nativeConnectionUnconfigured;
  };
  const persist = async (secret: string | null) => {
    if (busy) return;
    busy = true;
    input.value = "";
    controls();
    status.textContent = messages.launchPathSaving;
    try {
      show(
        await (secret !== null && needsWorkspace
          ? settings.set(secret, workspace.value.trim())
          : settings.set(secret)),
      );
    } catch {
      status.textContent = messages.nativeConnectionSaveError;
    } finally {
      busy = false;
      controls();
    }
  };
  input.addEventListener("input", controls);
  workspace.addEventListener("input", controls);
  save.addEventListener("click", () => {
    if (!save.disabled) void persist(input.value.trim());
  });
  clear.addEventListener("click", () => {
    void persist(null);
  });
  controls();
  void settings
    .get()
    .then(show)
    .catch(() => {
      section.hidden = true;
    })
    .finally(() => {
      busy = false;
      controls();
    });
  return section;
}
