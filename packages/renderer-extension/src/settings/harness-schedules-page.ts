import type { DesktopHarnessSchedules } from "@codexhost/desktop-control/renderer-bindings";
import {
  parseHarnessScheduleTime,
  type HarnessSchedule,
  type HarnessScheduleResult,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../renderer-model-client.js";
import {
  RendererSettingsPageScope,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageMountContext,
} from "./core.js";
import type { RendererImportedThreadOpener } from "./session-import-page.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountHarnessScheduleForm } from "./harness-schedule-form.js";
import { createRendererSettingsIcon } from "./icons.js";

export interface HarnessSchedulesPageOptions {
  connect(): Promise<DesktopHarnessSchedules>;
  getModelClient(): RendererModelClient | null;
  openThread?: RendererImportedThreadOpener;
}
export function createHarnessSchedulesPage(
  messages: RendererSettingsMessages,
  options: HarnessSchedulesPageOptions,
  openThread: RendererImportedThreadOpener | null,
): RendererSettingsPageDefinition {
  const openChat = options.openThread ?? openThread;
  const t = (zh: string, en: string) => (messages.locale === "zh-CN" ? zh : en);
  return {
    id: "harness-schedules",
    label: t("定时任务", "Schedules"),
    icon: "schedules",
    mount(context) {
      const document = context.content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
        const node = document.createElement(tag);
        node.className = className;
        node.textContent = text;
        return node;
      };
      const root = el("div", "mx-auto flex w-full max-w-3xl flex-col gap-5 text-settings-text");
      context.content.append(root);
      let viewScope: RendererSettingsPageScope | null = null;
      const nextView = (): RendererSettingsPageMountContext => {
        viewScope?.dispose();
        viewScope = new RendererSettingsPageScope();
        root.replaceChildren();
        return {
          content: root,
          signal: viewScope.signal,
          runLatest: viewScope.runLatest.bind(viewScope),
        };
      };
      const dispose = () => viewScope?.dispose();
      context.signal.addEventListener("abort", dispose, { once: true });
      const focusClass =
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus";
      const quietButtonClass = `inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-sm text-settings-muted hover:bg-settings-hover hover:text-settings-text disabled:opacity-50 ${focusClass}`;
      const showForm = (connection: DesktopHarnessSchedules, editing?: HarnessSchedule) => {
        mountHarnessScheduleForm(
          nextView(),
          messages,
          {
            connection,
            getModelClient: options.getModelClient,
            ...(editing ? { editing } : {}),
            onDone: (message) => showList(connection, message),
            onBack: () => showList(connection),
          },
          openChat,
        );
      };
      const showList = (connection: DesktopHarnessSchedules, message = "") => {
        if (context.signal.aborted) return;
        const view = nextView();
        const header = el("div", "flex flex-wrap items-end justify-between gap-x-4 gap-y-3");
        const heading = el("div", "flex min-w-0 flex-col gap-1");
        const title = el("h2", "m-0 text-xl leading-7 font-semibold", t("定时任务", "Schedules"));
        const subtitle = el(
          "p",
          "m-0 text-[13px] leading-5 text-settings-muted",
          t(
            "本地固定聊天日程。打开聊天查看历次记录。",
            "Local fixed chat schedules. Open the chat to see previous runs.",
          ),
        );
        heading.append(title, subtitle);
        const toolbar = el("div", "flex shrink-0 items-center gap-1");
        const refresh = el("button", quietButtonClass, t("刷新", "Refresh"));
        refresh.type = "button";
        refresh.prepend(createRendererSettingsIcon("refresh", 15));
        const create = el(
          "button",
          `inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border-0 bg-settings-primary px-3.5 py-2 text-sm font-medium text-settings-primary-text hover:opacity-90 disabled:opacity-50 ${focusClass}`,
          t("新建任务", "New schedule"),
        );
        create.type = "button";
        create.disabled = Boolean(connection.creationUnavailableReason);
        if (connection.creationUnavailableReason)
          create.title = connection.creationUnavailableReason;
        create.prepend(createRendererSettingsIcon("add", 16));
        toolbar.append(refresh, create);
        header.append(heading, toolbar);
        const status = el(
          "p",
          "m-0 break-words text-sm text-settings-muted",
          t("正在读取任务…", "Loading tasks…"),
        );
        status.setAttribute("role", "status");
        const rows = el(
          "fieldset",
          "m-0 flex min-w-0 flex-col border-0 border-t border-settings-divider p-0",
        );
        root.append(header, status, rows);
        let pending = false;
        const busy = (value: boolean) => {
          pending = value;
          rows.disabled = refresh.disabled = value;
          create.disabled = value || Boolean(connection.creationUnavailableReason);
        };
        create.addEventListener("click", () => showForm(connection));
        refresh.addEventListener("click", () => showList(connection));
        const operate = (
          card: HTMLElement,
          action: (signal: AbortSignal) => Promise<HarnessScheduleResult>,
        ) => {
          if (pending) return;
          busy(true);
          status.hidden = false;
          status.textContent = t(
            "正在保存；离开页面不保证撤销已提交操作。",
            "Saving; leaving this page may not cancel submitted operations.",
          );
          void view.runLatest(action, {
            success(result) {
              if (result.outcome === "saved") {
                showList(connection, t("操作完成。", "Done."));
                return;
              }
              busy(false);
              status.textContent =
                result.outcome === "unknown"
                  ? t(
                      "结果尚未确认，请刷新核对后再操作；不会自动重试。",
                      "Outcome unconfirmed. Refresh to check before another action; no automatic retry.",
                    )
                  : `${t("操作未完成。", "Operation did not finish.")} ${result.message ?? ""}`;
              if (result.outcome === "unknown")
                for (const button of card.querySelectorAll<HTMLButtonElement>(
                  "[data-schedule-write]",
                ))
                  button.disabled = true;
            },
            failure() {
              busy(false);
              status.textContent = t(
                "结果未知，请刷新核对。",
                "Outcome unknown. Refresh to check.",
              );
              for (const button of card.querySelectorAll<HTMLButtonElement>(
                "[data-schedule-write]",
              ))
                button.disabled = true;
            },
          });
        };
        void view.runLatest((signal) => connection.list(signal), {
          success(result) {
            status.textContent = [
              message,
              connection.creationUnavailableReason
                ? `${t("新建暂不可用。", "New schedules are unavailable.")} ${connection.creationUnavailableReason}`
                : "",
              result.unresolved
                ? t(
                    `有 ${result.unresolved} 个任务的归属或数据未能确认，未开放操作。请刷新重试。`,
                    `${result.unresolved} task(s) could not be verified; their actions are unavailable. Refresh to retry.`,
                  )
                : "",
            ]
              .filter(Boolean)
              .join(" ");
            status.hidden = !status.textContent;
            if (!result.items.length && !result.unresolved)
              rows.append(
                el("p", "text-sm text-settings-muted", t("暂无定时任务。", "No schedules.")),
              );
            for (const item of result.items) {
              const card = el(
                "article",
                "grid min-w-0 grid-cols-1 gap-3 border-b border-settings-divider py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-5",
              );
              card.setAttribute("aria-label", item.name);
              const main = el("div", "flex min-w-0 flex-1 flex-col gap-1.5");
              const titleLine = el("div", "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1");
              titleLine.append(
                el("h3", "m-0 min-w-0 break-words text-[15px] leading-5 font-semibold", item.name),
                el(
                  "span",
                  "inline-flex max-w-full items-center rounded-full bg-settings-inset px-2 py-0.5 text-[11px] leading-4 text-settings-muted",
                  item.harnessId === "codex" ? "Codex" : item.harnessId,
                ),
              );
              const statusLabel = el(
                "span",
                "inline-flex shrink-0 items-center gap-1.5 text-xs text-settings-muted",
              );
              const statusDot = el(
                "span",
                `size-1.5 rounded-full ${item.status === "ACTIVE" ? "bg-settings-success" : "bg-settings-warning"}`,
              );
              statusDot.setAttribute("aria-hidden", "true");
              statusLabel.append(
                statusDot,
                document.createTextNode(
                  item.status === "ACTIVE" ? t("已启用", "Active") : t("已暂停", "Paused"),
                ),
              );
              titleLine.append(statusLabel);
              const time = parseHarnessScheduleTime(item.rrule);
              const days =
                messages.locale === "zh-CN"
                  ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
                  : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
              const schedule = time
                ? `${time.frequency === "daily" ? t("每天", "Daily") : days[time.weekday]} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
                : t(
                    "自定义周期（时间请在官方列表编辑）",
                    "Custom schedule (edit time in the official list)",
                  );
              main.append(
                titleLine,
                el(
                  "p",
                  "m-0 break-words text-sm leading-5 font-medium text-settings-text tabular-nums",
                  schedule,
                ),
              );
              const actions = el(
                "div",
                "flex flex-wrap items-center gap-0.5 sm:shrink-0 sm:justify-end",
              );
              const action = (
                label: string,
                handler: () => void,
                kind: "primary" | "quiet" | "danger" = "quiet",
                write = false,
              ) => {
                const actionClass =
                  kind === "primary"
                    ? `inline-flex min-h-9 items-center justify-center rounded-lg border-0 bg-settings-hover px-3 text-sm font-medium text-settings-text hover:bg-settings-active disabled:opacity-50 ${focusClass}`
                    : `${quietButtonClass} ${kind === "danger" ? "hover:text-settings-danger" : ""}`;
                const button = el("button", actionClass, label);
                button.type = "button";
                if (write) button.dataset.scheduleWrite = "";
                button.addEventListener("click", handler);
                actions.append(button);
                return button;
              };
              if (openChat)
                action(
                  t("打开聊天", "Open chat"),
                  () => {
                    void openChat(item.targetThreadId, view.signal).catch(() => {
                      if (!view.signal.aborted) {
                        status.hidden = false;
                        status.textContent = t(
                          "无法打开聊天，请从侧栏进入。",
                          "Open this chat from the sidebar.",
                        );
                      }
                    });
                  },
                  "primary",
                );
              action(t("修改", "Edit"), () => showForm(connection, item), "quiet", true);
              action(
                item.status === "ACTIVE" ? t("暂停", "Pause") : t("恢复", "Resume"),
                () =>
                  operate(card, (signal) =>
                    connection.setStatus(
                      item,
                      item.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                      signal,
                    ),
                  ),
                "quiet",
                true,
              );
              const remove = action(
                t("删除", "Delete"),
                () => {
                  if (card.querySelector("[data-delete-confirmation]")) return;
                  const confirmation = el(
                    "div",
                    "flex flex-col gap-3 rounded-lg bg-settings-inset p-3 text-sm",
                  );
                  confirmation.dataset.deleteConfirmation = "";
                  confirmation.setAttribute("role", "group");
                  confirmation.setAttribute(
                    "aria-label",
                    t("确认删除日程", "Confirm schedule deletion"),
                  );
                  confirmation.append(
                    el(
                      "p",
                      "m-0",
                      t(
                        "只删除日程，保留聊天记录和工作区文件，不停止正在运行的任务。确认删除？",
                        "Delete only the schedule? Chat history and workspace files stay, and a running turn is not stopped.",
                      ),
                    ),
                  );
                  const buttons = el("div", "flex gap-2");
                  const cancel = el("button", quietButtonClass, t("取消", "Cancel"));
                  cancel.type = "button";
                  cancel.addEventListener("click", () => {
                    confirmation.remove();
                    remove.focus();
                  });
                  const confirm = el(
                    "button",
                    `min-h-9 rounded-lg border border-settings-danger bg-transparent px-3.5 py-2 text-sm font-medium text-settings-danger hover:bg-settings-hover disabled:opacity-50 ${focusClass}`,
                    t("确认删除", "Confirm delete"),
                  );
                  confirm.type = "button";
                  confirm.dataset.scheduleWrite = "";
                  confirm.addEventListener("click", () =>
                    operate(card, (signal) => connection.delete(item, signal)),
                  );
                  buttons.append(cancel, confirm);
                  confirmation.append(buttons);
                  confirmation.classList.add("sm:col-span-2");
                  card.append(confirmation);
                  cancel.focus();
                },
                "danger",
                true,
              );
              card.append(main, actions);
              rows.append(card);
            }
          },
          failure(error) {
            status.textContent = `${t("任务列表读取失败，不代表没有任务。", "Could not read tasks; the list may not be empty.")} ${error instanceof Error ? error.message : ""}`;
          },
        });
      };
      root.append(
        el("p", "text-sm text-settings-muted", t("正在连接 Desktop…", "Connecting to Desktop…")),
      );
      void context.runLatest(() => options.connect(), {
        success(connection) {
          showList(connection);
        },
        failure(error) {
          root.replaceChildren(
            el(
              "p",
              "text-sm text-settings-muted",
              `${t("当前窗口无法管理定时任务。", "Schedules are unavailable in this window.")} ${error instanceof Error ? error.message : ""}`,
            ),
          );
          root.firstElementChild?.setAttribute("role", "status");
        },
      });
      return dispose;
    },
  };
}
