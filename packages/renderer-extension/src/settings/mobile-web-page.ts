import type { RendererSettingsPageDefinition } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { remoteElement, remoteErrorMessage } from "./remote-connections-card.js";

/** Phones and other devices reach this computer through the background Web; this page only opens its settings. */
export function createMobileWebPage(
  messages: RendererSettingsMessages,
  getOpenWeb: () => (() => Promise<unknown>) | undefined,
): RendererSettingsPageDefinition {
  const zh = messages.locale === "zh-CN";
  const t = (cn: string, en: string): string => (zh ? cn : en);
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "mobile-web",
    label: messages.pageLabels["mobile-web"],
    icon: "mobile",
    mount({ content }) {
      const document = content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className = "",
        text = "",
      ): HTMLElementTagNameMap[K] => remoteElement(document, tag, className, text);
      const root = el("div", "settings-remote");
      const header = el("div", "settings-remote__header");
      const copy = el("div");
      copy.append(
        el("h1", "settings-section-label", messages.pageLabels["mobile-web"]),
        el(
          "p",
          "settings-page-description",
          t(
            "在手机或其他设备的浏览器上使用这台电脑的 CodexHost，这台电脑需要保持开机和联网。",
            "Use this computer's CodexHost from a browser on your phone or another device. This computer must stay on and connected to the network.",
          ),
        ),
      );
      header.append(copy);
      const label = t("在浏览器中打开连接设置", "Open connection settings in browser");
      const button = el("button", "settings-command-button", "");
      button.type = "button";
      button.textContent = label;
      const status = el("div", "settings-remote__banner");
      status.setAttribute("role", "alert");
      status.hidden = true;
      const openWeb = getOpenWeb();
      if (!openWeb) {
        button.disabled = true;
        status.textContent = t("此窗口无法打开 Web。", "Web cannot be opened from this window.");
        status.hidden = false;
      }
      button.addEventListener("click", () => {
        if (!openWeb) return;
        button.disabled = true;
        status.hidden = true;
        void openWeb()
          .catch((error: unknown) => {
            status.textContent = `${t("Web 打开失败", "Web could not be opened")}: ${remoteErrorMessage(error)}`;
            status.hidden = false;
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      const actions = el("div", "settings-remote__toolbar");
      actions.append(button);
      root.append(header, actions, status);
      content.append(root);
    },
  });
}
