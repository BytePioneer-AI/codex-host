import { readCpaLiveVoiceHookConfig } from "../renderer-cpa-live-voice-hook.js";
import {
  CODEX_USAGE_BANNER_CHANGE_EVENT,
  readCodexUsageBannerPreference,
  writeCodexUsageBannerPreference,
} from "../renderer-codex-usage-banner-preference.js";
import {
  CHAT_LIVE_VOICE_CHANGE_EVENT,
  CPA_LIVE_VOICE_CHANGE_EVENT,
  readChatLiveVoicePreference,
  readCpaLiveVoicePreference,
  writeChatLiveVoicePreference,
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

function voiceChoice(
  document: Document,
  id: string,
  describedBy: string,
  nativeLabel: string,
  gatewayLabel: string,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  select.setAttribute("aria-describedby", describedBy);
  select.className =
    "rounded-md border border-settings-border bg-settings-panel px-3 py-2 text-settings-text";
  for (const [value, label] of [
    ["native", nativeLabel],
    ["gateway", gatewayLabel],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  return select;
}

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null = () => null,
  openConsole?: () => Promise<unknown>,
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
      const usageBannerId = preferenceId("hide-codex-usage-banner");
      const usageBannerRow = createPreferenceItem(document, {
        title: messages.hideCodexUsageBannerTitle,
        description: messages.hideCodexUsageBannerDescription,
        controlId: usageBannerId,
        help: {
          label: messages.hideCodexUsageBannerHelpLabel,
          lines: messages.hideCodexUsageBannerHelp,
        },
      });
      const usageBanner = createPreferenceSwitch(
        document,
        usageBannerId,
        usageBannerRow.description.id,
      );
      usageBanner.checked = readCodexUsageBannerPreference(ownerWindow);
      usageBanner.addEventListener("change", () => {
        writeCodexUsageBannerPreference(ownerWindow, usageBanner.checked);
      });
      const syncUsageBanner = (): void => {
        usageBanner.checked = readCodexUsageBannerPreference(ownerWindow);
      };
      ownerWindow.addEventListener(CODEX_USAGE_BANNER_CHANGE_EVENT, syncUsageBanner);
      usageBannerRow.item.append(usageBanner);
      card.append(usageBannerRow.item);

      const liveVoiceId = preferenceId("cpa-live-voice");
      const liveVoiceRow = createPreferenceItem(document, {
        title: messages.cpaLiveVoiceTitle,
        description: messages.cpaLiveVoiceDescription,
        controlId: liveVoiceId,
        help: { label: messages.cpaLiveVoiceHelpLabel, lines: messages.cpaLiveVoiceHelp },
      });
      const liveVoice = voiceChoice(
        document,
        liveVoiceId,
        liveVoiceRow.description.id,
        messages.voiceDesktopDefault,
        messages.voiceGateway,
      );
      liveVoice.value = readCpaLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      liveVoice.addEventListener("change", () => {
        writeCpaLiveVoicePreference(ownerWindow, liveVoice.value === "gateway");
        liveVoice.value = readCpaLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      });
      const syncLiveVoice = (): void => {
        liveVoice.value = readCpaLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      };
      ownerWindow.addEventListener(CPA_LIVE_VOICE_CHANGE_EVENT, syncLiveVoice);
      liveVoiceRow.item.append(liveVoice);
      const injected = Boolean(readCpaLiveVoiceHookConfig(ownerWindow));
      liveVoice.disabled = !injected;
      if (!injected) {
        const warning = document.createElement("div");
        warning.className = "text-xs leading-[18px] text-settings-warning";
        warning.setAttribute("role", "status");
        warning.textContent = messages.cpaLiveVoiceRestartRequired;
        liveVoiceRow.description.after(warning);
        if (openConsole) {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "settings-command-button settings-command-button--secondary";
          open.textContent = messages.cpaLiveVoiceOpenConsole;
          open.addEventListener("click", () => {
            open.disabled = true;
            void Promise.resolve()
              .then(openConsole)
              .catch((error: unknown) => {
                warning.textContent = `${messages.aboutConsoleFailed}: ${error instanceof Error ? error.message : String(error)}`;
              })
              .finally(() => {
                open.disabled = false;
              });
          });
          warning.after(open);
        }
      }
      card.append(liveVoiceRow.item);

      const chatVoiceId = preferenceId("chat-live-voice");
      const chatVoiceRow = createPreferenceItem(document, {
        title: messages.chatLiveVoiceTitle,
        description: messages.chatLiveVoiceDescription,
        controlId: chatVoiceId,
        help: { label: messages.chatLiveVoiceHelpLabel, lines: messages.chatLiveVoiceHelp },
      });
      const chatVoice = voiceChoice(
        document,
        chatVoiceId,
        chatVoiceRow.description.id,
        "ChatGPT",
        messages.voiceGateway,
      );
      chatVoice.value = readChatLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      chatVoice.addEventListener("change", () => {
        writeChatLiveVoicePreference(ownerWindow, chatVoice.value === "gateway");
        chatVoice.value = readChatLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      });
      const syncChatVoice = (): void => {
        chatVoice.value = readChatLiveVoicePreference(ownerWindow) ? "gateway" : "native";
      };
      ownerWindow.addEventListener(CHAT_LIVE_VOICE_CHANGE_EVENT, syncChatVoice);
      chatVoice.disabled = !injected;
      chatVoiceRow.item.append(chatVoice);
      card.append(chatVoiceRow.item);

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
        ownerWindow.removeEventListener(CODEX_USAGE_BANNER_CHANGE_EVENT, syncUsageBanner);
        ownerWindow.removeEventListener(CPA_LIVE_VOICE_CHANGE_EVENT, syncLiveVoice);
        ownerWindow.removeEventListener(CHAT_LIVE_VOICE_CHANGE_EVENT, syncChatVoice);
        ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
        disposeIdleRelease();
      };
    },
  });
}
