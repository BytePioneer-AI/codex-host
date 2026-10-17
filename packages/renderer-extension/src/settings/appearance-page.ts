import { readCpaLiveVoiceHookConfig } from "../renderer-cpa-live-voice-hook.js";
import {
  CPA_LIVE_VOICE_CHANGE_EVENT,
  readCpaLiveVoicePreference,
  writeCpaLiveVoicePreference,
} from "../renderer-cpa-live-voice-preference.js";
import {
  REASONING_SOFT_WRAP_CHANGE_EVENT,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../renderer-transcript-dom.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountIdleReleaseControls } from "./idle-release-controls.js";
import type { LoadedSessionsClient } from "./loaded-sessions-table.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "appearance",
    label: messages.pageLabels.appearance,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      if (!ownerWindow) return;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.appearance;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.appearanceDescription;

      const { group, card } = createPreferenceGroup(document, messages.appearanceGroup);
      const liveVoiceId = preferenceId("cpa-live-voice");
      const liveVoiceRow = createPreferenceItem(document, {
        title: messages.cpaLiveVoiceTitle,
        description: messages.cpaLiveVoiceDescription,
        controlId: liveVoiceId,
        help: { label: messages.cpaLiveVoiceHelpLabel, lines: messages.cpaLiveVoiceHelp },
      });
      const liveVoice = createPreferenceSwitch(document, liveVoiceId, liveVoiceRow.description.id);
      liveVoice.checked = readCpaLiveVoicePreference(ownerWindow);
      liveVoice.addEventListener("change", () => {
        writeCpaLiveVoicePreference(ownerWindow, liveVoice.checked);
      });
      const syncLiveVoice = (): void => {
        liveVoice.checked = readCpaLiveVoicePreference(ownerWindow);
      };
      ownerWindow.addEventListener(CPA_LIVE_VOICE_CHANGE_EVENT, syncLiveVoice);
      liveVoiceRow.item.append(liveVoice);
      if (!readCpaLiveVoiceHookConfig(ownerWindow)) {
        const warning = document.createElement("div");
        warning.className = "text-xs leading-[18px] text-settings-warning";
        warning.setAttribute("role", "status");
        warning.textContent = messages.cpaLiveVoiceRestartRequired;
        liveVoiceRow.description.after(warning);
      }
      card.append(liveVoiceRow.item);

      const softWrapId = preferenceId("reasoning-soft-wrap");
      const row = createPreferenceItem(document, {
        title: messages.reasoningSoftWrapTitle,
        description: messages.reasoningSoftWrapDescription,
        controlId: softWrapId,
      });
      const toggle = createPreferenceSwitch(document, softWrapId, row.description.id);
      toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      toggle.addEventListener("change", () => {
        setReasoningTranscriptSoftWrap(ownerWindow, toggle.checked);
      });
      const sync = (): void => {
        toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      };
      ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
      row.item.append(toggle);
      card.append(row.item);

      context.content.append(heading, description, group);
      const disposeIdleRelease = mountIdleReleaseControls(
        context,
        messages,
        getLoadedSessionsClient,
      );
      return () => {
        ownerWindow.removeEventListener(CPA_LIVE_VOICE_CHANGE_EVENT, syncLiveVoice);
        ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
        disposeIdleRelease();
      };
    },
  });
}
