import {
  SETTINGS_PLUGIN_LIST_METHOD,
  settingsPluginListResultSchema,
  settingsPluginReadResultSchema,
  type SettingsPluginListResult,
  type SettingsPluginReadParams,
} from "@codexhost/shared-contracts";
import type { RendererSettingsPageDefinition } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { isUnsupportedMethod } from "../renderer-request-sender.js";

export interface SettingsPageClient {
  listSettingsPages(): Promise<SettingsPluginListResult>;
  readSettingsPage(input: SettingsPluginReadParams): Promise<{ html: string }>;
}

function messages(locale: string) {
  return locale === "zh-CN"
    ? {
        title: "扩展页面",
        loading: "正在加载页面…",
        retry: "重试",
        failed: "无法加载扩展页面。请检查本机 settings-plugins 的配置和页面文件，然后重试。",
        discoveryFailed:
          "部分扩展页面不可用。请检查本机 settings-plugins 的启用配置和插件清单，然后重新打开设置。",
      }
    : {
        title: "Extension pages",
        loading: "Loading page…",
        retry: "Try again",
        failed:
          "Could not load the extension page. Check the local settings-plugins configuration and page files, then try again.",
        discoveryFailed:
          "Some extension pages are unavailable. Check the local settings-plugins configuration and manifests, then reopen settings.",
      };
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    if (signal.aborted) throw new Error("Settings page request aborted");
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Settings page request timed out")), 5_000);
        abort = () => reject(new Error("Settings page request aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// 页面只获得自己的脚本执行环境；不授予宿主同源、弹窗、表单或顶层导航能力。
const DOCUMENT_PREFIX =
  "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\"><meta name=\"referrer\" content=\"no-referrer\">";

export async function loadPluginSettingsPages(
  getClient: () => SettingsPageClient | null,
  locale: RendererSettingsMessages["locale"],
  signal: AbortSignal,
): Promise<readonly RendererSettingsPageDefinition[]> {
  const client = getClient();
  if (!client) return [];
  const text = messages(locale);
  let snapshot: SettingsPluginListResult;
  try {
    snapshot = settingsPluginListResultSchema.parse(
      await bounded(() => client.listSettingsPages(), signal),
    );
  } catch (error) {
    if (isUnsupportedMethod(error, SETTINGS_PLUGIN_LIST_METHOD)) return [];
    snapshot = { pages: [], unavailable: ["unavailable"] };
  }
  if (signal.aborted) return [];
  const definitions: RendererSettingsPageDefinition[] = snapshot.pages.map((page) =>
    Object.freeze<RendererSettingsPageDefinition>({
      id: `plugin/${page.pluginId}/${page.id}`,
      label: page.title,
      icon: "settings",
      iconText: page.icon,
      mount(context) {
        const document = context.content.ownerDocument;
        const heading = document.createElement("h1");
        heading.textContent = page.title;
        heading.className = "m-0 mb-4 text-2xl font-semibold";
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        status.className = "text-[13px] text-settings-muted empty:hidden";
        const body = document.createElement("div");
        const retry = document.createElement("button");
        retry.textContent = text.retry;
        retry.className =
          "cursor-pointer rounded-md border border-settings-border bg-settings-panel px-3 py-2 text-settings-text";
        retry.addEventListener("click", load, { signal: context.signal });
        context.content.append(heading, status, body);
        function load() {
          status.textContent = text.loading;
          body.replaceChildren();
          void context.runLatest(
            async () => {
              const current = getClient();
              if (!current) throw new Error("Local settings page connection unavailable");
              return settingsPluginReadResultSchema.parse(
                await bounded(
                  () => current.readSettingsPage({ pluginId: page.pluginId, pageId: page.id }),
                  context.signal,
                ),
              );
            },
            {
              success({ html }) {
                const frame = document.createElement("iframe");
                frame.title = page.title;
                frame.className =
                  "block h-[max(420px,65vh)] w-full rounded-[10px] border border-settings-border bg-white";
                frame.setAttribute("sandbox", "allow-scripts");
                frame.referrerPolicy = "no-referrer";
                frame.srcdoc = DOCUMENT_PREFIX + html;
                body.append(frame);
                status.textContent = "";
              },
              failure() {
                status.textContent = text.failed;
                body.replaceChildren(retry);
              },
            },
          );
        }
        load();
      },
    }),
  );
  if (snapshot.unavailable.length)
    definitions.push(
      Object.freeze<RendererSettingsPageDefinition>({
        id: "plugin-pages-unavailable",
        label: text.title,
        icon: "alert",
        mount({ content }) {
          const status = content.ownerDocument.createElement("p");
          status.setAttribute("role", "status");
          status.textContent = text.discoveryFailed;
          content.append(status);
        },
      }),
    );
  return definitions;
}
