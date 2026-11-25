import type { RendererSettingsPageDefinition } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface HarnessSchedulesPageOptions {
  openSchedules(signal: AbortSignal): Promise<void>;
}

/** Sidebar shortcut; Desktop owns the schedule list and all task operations. */
export function createHarnessSchedulesPage(
  messages: RendererSettingsMessages,
  options: HarnessSchedulesPageOptions,
): RendererSettingsPageDefinition {
  const t = (zh: string, en: string) => (messages.locale === "zh-CN" ? zh : en);
  return {
    id: "harness-schedules",
    label: t("定时任务", "Schedules"),
    icon: "schedules",
    mount(context) {
      const navigate = () => {
        context.content.replaceChildren();
        void context.runLatest((signal) => options.openSchedules(signal), {
          success() {},
          failure() {
            const document = context.content.ownerDocument;
            const status = document.createElement("p");
            status.setAttribute("role", "status");
            status.className = "text-sm text-settings-muted";
            status.textContent = t(
              "无法打开官方定时任务页，请重试或从官方侧栏进入。",
              "Could not open the official schedules page. Retry or use the Desktop sidebar.",
            );
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className =
              "rounded-lg px-3 py-2 text-sm text-settings-text hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-settings-focus";
            retry.textContent = t("重试", "Retry");
            retry.addEventListener("click", navigate);
            context.content.replaceChildren(status, retry);
          },
        });
      };
      navigate();
      return undefined;
    },
  };
}
