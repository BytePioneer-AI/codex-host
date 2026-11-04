import type {
  HarnessId,
  HarnessUserInstructionsSet,
  HarnessUserInstructionsSettings,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { LoadedSessionsClient } from "./loaded-sessions-table.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

type UserInstructionsSyncStatus = "applied" | "pending" | "unavailable" | "failed";

const HARNESS_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  codebuddy: "CodeBuddy",
  copilot: "GitHub Copilot",
  "cursor-cli": "Cursor CLI",
  "deepseek-harness": "DeepSeek Harness",
  devin: "Devin",
  grok: "Grok",
  hermes: "Hermes",
  "kimi-code": "Kimi Code",
  "kiro-cli": "Kiro CLI",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "qwen-code": "Qwen Code",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
});

function harnessLabel(harnessId: string): string {
  return HARNESS_DISPLAY_NAMES[harnessId] ?? harnessId;
}

export function mountUserInstructionsControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => LoadedSessionsClient | null,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const { group, header, card } = createPreferenceGroup(document, messages.userInstructionsSection);

  const status = document.createElement("div");
  status.className =
    "group/status ml-auto inline-flex items-center gap-1.5 text-xs leading-[18px] text-settings-muted data-[state=failed]:text-settings-danger data-[state=unavailable]:text-settings-warning";
  const statusDot = document.createElement("span");
  statusDot.setAttribute("aria-hidden", "true");
  statusDot.className =
    "size-1.5 shrink-0 rounded-full bg-settings-subtle group-data-[state=failed]/status:bg-settings-danger group-data-[state=unavailable]/status:bg-settings-warning";
  const statusText = document.createElement("span");
  statusText.setAttribute("role", "status");
  status.append(statusDot, statusText);
  header.append(status);

  const enabledId = preferenceId("user-instructions-enabled");
  const masterRow = createPreferenceItem(document, {
    title: messages.userInstructionsTitle,
    description: messages.userInstructionsDescription,
    controlId: enabledId,
    help: { label: messages.userInstructionsHelpLabel, lines: messages.userInstructionsHelp },
  });
  const masterSwitch = createPreferenceSwitch(document, enabledId, masterRow.description.id);
  masterSwitch.disabled = true;
  masterRow.item.append(masterSwitch);

  const harnessContainer = document.createElement("div");
  harnessContainer.id = preferenceId("user-instructions-harnesses");
  harnessContainer.hidden = true;
  masterSwitch.setAttribute("aria-controls", harnessContainer.id);

  card.append(masterRow.item, harnessContainer);
  content.append(group);

  let disposed = false;
  let currentSettings: HarnessUserInstructionsSettings | null = null;
  let requestVersion = 0;

  const statusMessages: Record<Exclude<UserInstructionsSyncStatus, "applied">, string> = {
    pending: messages.userInstructionsPending,
    unavailable: messages.userInstructionsUnavailable,
    failed: messages.userInstructionsFailed,
  };

  const showStatus = (value: UserInstructionsSyncStatus): void => {
    status.dataset.state = value;
    status.hidden = value === "applied";
    statusText.textContent = value === "applied" ? "" : statusMessages[value];
  };

  const renderSettings = (settings: HarnessUserInstructionsSettings): void => {
    currentSettings = settings;
    masterSwitch.disabled = false;
    masterSwitch.checked = settings.enabled;
    harnessContainer.hidden = !settings.enabled;
    harnessContainer.replaceChildren();
    for (const entry of settings.harnesses) {
      const switchId = preferenceId(`user-instructions-${entry.harnessId}`);
      const row = createPreferenceItem(document, {
        title: harnessLabel(entry.harnessId),
        description: `${settings.sourcePath} → ${entry.targetPath}`,
        controlId: switchId,
      });
      const toggle = createPreferenceSwitch(document, switchId, row.description.id);
      toggle.checked = entry.enabled;
      toggle.dataset.userInstructionsHarness = entry.harnessId;
      toggle.addEventListener("change", () => {
        if (!currentSettings) return;
        const disabledHarnesses: HarnessId[] = currentSettings.harnesses
          .filter((candidate) =>
            candidate.harnessId === entry.harnessId ? !toggle.checked : !candidate.enabled,
          )
          .map((candidate) => candidate.harnessId);
        void save({
          enabled: currentSettings.enabled,
          disabledHarnesses,
        });
      });
      row.item.append(toggle);
      harnessContainer.append(row.item);
    }
  };

  const save = async (input: HarnessUserInstructionsSet): Promise<void> => {
    const client = getClient();
    if (!client?.setHarnessUserInstructionsSettings) {
      showStatus("unavailable");
      if (currentSettings) renderSettings(currentSettings);
      return;
    }
    const version = ++requestVersion;
    showStatus("pending");
    try {
      const updated = await client.setHarnessUserInstructionsSettings(input);
      if (disposed || context.signal.aborted || version !== requestVersion) return;
      renderSettings(updated);
      showStatus("applied");
    } catch (error) {
      if (disposed || context.signal.aborted || version !== requestVersion) return;
      if (currentSettings) renderSettings(currentSettings);
      showStatus(error instanceof RendererMethodUnavailableError ? "unavailable" : "failed");
    }
  };

  masterSwitch.addEventListener("change", () => {
    const disabledHarnesses = currentSettings
      ? currentSettings.harnesses
          .filter((candidate) => !candidate.enabled)
          .map((candidate) => candidate.harnessId)
      : [];
    void save({
      enabled: masterSwitch.checked,
      disabledHarnesses,
    });
  });

  const load = async (): Promise<void> => {
    const client = getClient();
    if (!client?.getHarnessUserInstructionsSettings) {
      showStatus("unavailable");
      return;
    }
    const version = ++requestVersion;
    showStatus("pending");
    try {
      const loaded = await client.getHarnessUserInstructionsSettings();
      if (disposed || context.signal.aborted || version !== requestVersion) return;
      renderSettings(loaded);
      showStatus("applied");
    } catch (error) {
      if (disposed || context.signal.aborted || version !== requestVersion) return;
      showStatus(error instanceof RendererMethodUnavailableError ? "unavailable" : "failed");
    }
  };

  void load();

  return () => {
    disposed = true;
  };
}
