import { consolePost } from "../api.js";
import { h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleOverview, ConsoleState } from "../state.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "../../settings/preference-ui.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";

export function createLiveVoicePage(
  messages: ConsoleMessages,
  state: ConsoleState,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "live-voice",
    label: messages.liveVoice,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let saving = false;
      let error: string | null = null;
      let disposed = false;
      const render = (): void => {
        if (disposed) return;
        const live = state.overview?.liveVoice;
        const heading = h(
          document,
          "div",
          { className: "settings-section-label" },
          messages.liveVoice,
        );
        const { group, card } = createPreferenceGroup(document, messages.liveVoice);
        const id = preferenceId("inject-live-voice");
        const row = createPreferenceItem(document, {
          title: messages.liveVoiceInjectTitle,
          description: messages.liveVoiceInjectDescription,
          controlId: id,
        });
        const toggle = createPreferenceSwitch(document, id, row.description.id);
        toggle.checked = live?.inject ?? true;
        toggle.disabled = saving || !live || state.offline || live.envOverride !== null;
        toggle.addEventListener("change", () => {
          const inject = toggle.checked;
          saving = true;
          error = null;
          render();
          void consolePost<ConsoleOverview["liveVoice"]>("/api/live-voice-inject", { inject })
            .then((saved) => {
              if (state.overview) state.overview.liveVoice = saved;
              return state.refresh();
            })
            .catch((failure: unknown) => {
              error = failure instanceof Error ? failure.message : String(failure);
            })
            .finally(() => {
              saving = false;
              render();
            });
        });
        row.item.append(toggle);
        card.append(row.item);
        if (live?.envOverride) {
          card.append(
            h(
              document,
              "p",
              { className: "text-xs leading-[18px] text-settings-warning" },
              messages.liveVoiceEnvOverride,
            ),
          );
        }
        card.append(
          h(
            document,
            "p",
            { className: "text-xs leading-[18px] text-settings-warning", role: "status" },
            messages.liveVoiceRelaunchRequired,
          ),
          h(
            document,
            "p",
            { className: "settings-page-description" },
            messages.liveVoiceConfigToml,
          ),
        );
        if (error) {
          card.append(
            h(document, "p", { className: "text-settings-danger", role: "alert" }, error),
          );
        }
        context.content.replaceChildren(heading, group);
      };
      render();
      const unsubscribe = state.subscribe(render);
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
  });
}
