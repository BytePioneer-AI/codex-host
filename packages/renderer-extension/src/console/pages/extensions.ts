import {
  resolveLocalizedExtensionText,
  type DesktopExtensionConfiguration,
  type DesktopExtensionManifest,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import type { RendererSettingsPageDefinition } from "../../settings/core.js";
import { consoleGet, consolePost } from "../api.js";
import { confirmAction } from "../confirm.js";
import { button, h } from "../dom.js";

interface Listing {
  configuration: DesktopExtensionConfiguration;
  desktopConnected: boolean;
  diagnostics: string[];
  extensions: Array<{
    id: string;
    manifest?: DesktopExtensionManifest;
    enabled: boolean;
    status: DesktopExtensionStatus;
  }>;
}

export function createExtensionsPage(locale: string): RendererSettingsPageDefinition {
  const zh = locale.startsWith("zh");
  const resolvedLocale = zh ? "zh-CN" : "en";
  const label = zh ? "Desktop 扩展" : "Desktop extensions";
  const states: Record<DesktopExtensionStatus["state"], string> = zh
    ? {
        running: "运行中",
        disabled: "未启用",
        waiting: "等待 Desktop",
        conflict: "槽位冲突",
        invalid: "无效",
        incompatible: "不兼容",
        failed: "失败",
      }
    : {
        running: "Running",
        disabled: "Disabled",
        waiting: "Waiting for Desktop",
        conflict: "Slot conflict",
        invalid: "Invalid",
        incompatible: "Incompatible",
        failed: "Failed",
      };
  const recovery = zh ? "禁用全部并重载 Desktop" : "Disable all and reload Desktop";
  return {
    id: "extensions",
    label,
    icon: "connections",
    mount({ content, signal }) {
      const document = content.ownerDocument;
      let listing: Listing | undefined;
      let busy = false;
      const error = h(document, "p", { role: "alert", className: "console-muted" });
      const list = h(document, "div", { className: "console-harness-list", "aria-label": label });
      const message = h(document, "p", { className: "console-muted", role: "status" });
      const diagnostics = h(document, "div", { className: "console-muted" });
      const render = (next: Listing) => {
        listing = next;
        message.textContent = next.desktopConnected ? "" : states.waiting;
        diagnostics.replaceChildren(
          ...next.diagnostics.map((entry) => h(document, "p", {}, entry)),
        );
        const describeConflictOwner = (conflictWithId: string): string => {
          const other = next.extensions.find((entry) => entry.id === conflictWithId);
          const otherName = other?.manifest
            ? resolveLocalizedExtensionText(other.manifest.name, resolvedLocale)
            : undefined;
          return otherName && otherName !== conflictWithId
            ? `${otherName} (${conflictWithId})`
            : conflictWithId;
        };
        list.replaceChildren(
          ...next.extensions.map(({ id, manifest, enabled, status }) => {
            const displayName = manifest
              ? resolveLocalizedExtensionText(manifest.name, resolvedLocale)
              : id;
            const description = manifest?.description
              ? resolveLocalizedExtensionText(
                  manifest.description["zh-CN"] !== undefined
                    ? { en: manifest.description.en, "zh-CN": manifest.description["zh-CN"] }
                    : { en: manifest.description.en },
                  resolvedLocale,
                ).trim()
              : "";
            const control = button(
              document,
              enabled ? (zh ? "禁用" : "Disable") : zh ? "启用" : "Enable",
              () => {
                void mutate(enabled ? "disable" : "enable", id).catch(() => undefined);
              },
            );
            control.disabled = !enabled && !manifest;
            const detail = status.conflictWith
              ? zh
                ? `槽位占用者：${describeConflictOwner(status.conflictWith)}`
                : `Slot occupied by ${describeConflictOwner(status.conflictWith)}`
              : status.error;
            const identity = h(
              document,
              "div",
              { className: "console-harness__identity" },
              h(
                document,
                "div",
                {},
                h(document, "strong", {}, displayName),
                description
                  ? h(document, "div", { className: "console-muted" }, description)
                  : null,
                manifest
                  ? h(
                      document,
                      "div",
                      { className: "console-muted" },
                      `${manifest.version} · ${manifest.slots.join(", ") || (zh ? "无独占槽位" : "No exclusive slots")}`,
                    )
                  : null,
              ),
              h(
                document,
                "span",
                { className: `console-badge is-${status.state === "running" ? "ok" : "info"}` },
                states[status.state],
              ),
              control,
            );
            return h(
              document,
              "div",
              { className: "console-harness" },
              identity,
              detail ? h(document, "p", { className: "console-muted" }, detail) : null,
            );
          }),
        );
        if (!next.extensions.length)
          list.append(
            h(
              document,
              "p",
              { className: "console-muted" },
              zh
                ? "尚未发现扩展。请将扩展目录复制到数据目录下的 extensions/。"
                : "No extensions found. Copy extension folders into extensions/ in the data directory.",
            ),
          );
      };
      let generation = 0;
      const load = async () => {
        const current = ++generation;
        try {
          const next = await consoleGet<Listing>("/api/extensions", signal);
          if (!signal.aborted && generation === current) render(next);
        } catch (cause) {
          if (!signal.aborted && generation === current) error.textContent = String(cause);
        }
      };
      async function mutate(action: string, id?: string) {
        if (busy) return;
        busy = true;
        error.textContent = "";
        try {
          await consolePost(
            `/api/extensions/${action}`,
            { ...(id ? { id } : {}), expectedRevision: listing?.configuration.revision ?? 0 },
            signal,
          );
        } catch (cause) {
          if (!signal.aborted)
            error.textContent = cause instanceof Error ? cause.message : String(cause);
          throw cause;
        } finally {
          if (!signal.aborted) await load();
          busy = false;
        }
      }
      const recover = button(document, recovery, () =>
        confirmAction(
          content,
          signal,
          recovery,
          zh
            ? "清除全部启用选择。Desktop 窗口会重载；未保存的界面状态可能丢失。"
            : "Clear all saved selections and reload the Desktop window. Unsaved UI state may be lost.",
          () => mutate("disable-all-and-reload"),
          zh,
        ),
      );
      content.append(
        h(document, "h2", {}, label),
        message,
        error,
        diagnostics,
        list,
        h(document, "div", { className: "console-actions" }, recover),
      );
      void load();
      const timer = window.setInterval(() => {
        if (!busy && !list.contains(document.activeElement)) void load();
      }, 5000);
      return () => window.clearInterval(timer);
    },
  };
}
