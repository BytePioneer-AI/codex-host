import type {
  DesktopHarnessSchedules,
  DesktopHarnessScheduleSession,
} from "@codexhost/desktop-control/renderer-bindings";
import {
  parseHarnessScheduleTime,
  type HarnessSchedule,
  type HarnessScheduleEdit,
  type HarnessScheduleResult,
  type HarnessId,
  type HarnessModel,
  type HarnessScheduleInput,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../renderer-model-client.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererImportedThreadOpener } from "./session-import-page.js";
import type { RendererSettingsMessages } from "./localization.js";

export function mountHarnessScheduleForm(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  options: {
    connection: DesktopHarnessSchedules;
    getModelClient(): RendererModelClient | null;
    editing?: HarnessSchedule;
    onDone(message: string): void;
    onBack(): void;
  },
  openThread: RendererImportedThreadOpener | null,
): void {
  const t = (zh: string, en: string) => (messages.locale === "zh-CN" ? zh : en);
  const editing = options.editing;
  const initialTime = editing ? parseHarnessScheduleTime(editing.rrule) : null;
  const { content, signal } = context;
  const document = content.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const fieldClass =
    "w-full min-w-0 rounded-lg border border-settings-border bg-settings-panel p-2 text-settings-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-focus disabled:opacity-50";
  const buttonClass =
    "min-h-9 rounded-lg border-0 bg-settings-primary px-4 py-2 text-sm font-medium text-settings-primary-text hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:opacity-50";
  const root = el("div", "mx-auto flex w-full max-w-2xl flex-col gap-4 text-settings-text");
  root.append(
    el(
      "h2",
      "m-0 text-xl leading-7 font-semibold",
      editing ? t("修改定时任务", "Edit schedule") : t("创建定时任务", "Create a schedule"),
    ),
    el(
      "p",
      "m-0 text-sm text-settings-muted",
      t(
        editing
          ? "修改日程不会更换聊天、Harness 或工作目录；Model 通过聊天修改。"
          : "在同一个聊天中重复执行，随时打开聊天查看历史。",
        editing
          ? "Editing keeps the chat, Harness and working directory. Change the Model in the chat."
          : "Runs in the same chat. Open the chat to see its history.",
      ),
    ),
  );
  const form = el(
    "form",
    "flex min-w-0 flex-col gap-5 rounded-xl border border-settings-divider bg-settings-panel p-4 sm:p-5",
  );
  const fields = el("fieldset", "m-0 flex min-w-0 flex-col gap-5 border-0 p-0");
  const field = (name: string, input: HTMLElement) => {
    const label = el("label", "flex min-w-0 flex-col gap-2 text-sm", name);
    label.append(input);
    return label;
  };
  const harness = el("select", fieldClass);
  harness.name = "harness";
  harness.autocomplete = "off";
  harness.required = true;
  harness.setAttribute("aria-label", "Harness");
  harness.append(new Option(t("选择 Harness", "Choose a Harness"), ""));
  const model = el("select", fieldClass);
  model.name = "model";
  model.autocomplete = "off";
  model.required = true;
  model.setAttribute("aria-label", "Model");
  model.disabled = true;
  const row = el("div", "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2");
  row.append(field("Harness", harness), field("Model", model));
  const prompt = el("textarea", `${fieldClass} min-h-28 resize-y [font:inherit]`);
  prompt.name = "prompt";
  prompt.autocomplete = "off";
  prompt.required = true;
  prompt.maxLength = 32000;
  prompt.setAttribute("aria-label", t("任务内容", "Task"));
  const frequency = el("select", fieldClass);
  frequency.name = "frequency";
  frequency.autocomplete = "off";
  frequency.setAttribute("aria-label", t("重复", "Repeat"));
  frequency.append(
    new Option(t("每天", "Daily"), "daily"),
    new Option(t("每周", "Weekly"), "weekly"),
  );
  const time = el("input", fieldClass);
  time.name = "time";
  time.autocomplete = "off";
  time.type = "time";
  time.value = "09:00";
  time.required = true;
  time.setAttribute("aria-label", t("本地时间", "Local time"));
  const weekday = el("select", fieldClass);
  weekday.name = "weekday";
  weekday.autocomplete = "off";
  weekday.setAttribute("aria-label", t("星期", "Day"));
  const days =
    messages.locale === "zh-CN"
      ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
      : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  days.forEach((day, index) => weekday.append(new Option(day, String(index))));
  weekday.value = "1";
  const dayField = field(t("星期", "Day"), weekday);
  dayField.hidden = true;
  frequency.addEventListener("change", () => {
    dayField.hidden = frequency.value !== "weekly";
  });
  const schedule = el("div", "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2");
  schedule.append(
    field(t("重复", "Repeat"), frequency),
    field(t("本地时间", "Local time"), time),
    dayField,
  );
  const advanced = el("details", "text-sm");
  const advancedSummary = el(
    "summary",
    "w-fit cursor-pointer rounded-sm text-settings-muted hover:text-settings-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus",
    t("高级设置", "Advanced"),
  );
  const cwd = el("input", `${fieldClass} mt-2`);
  cwd.name = "working-directory";
  cwd.autocomplete = "off";
  cwd.type = "text";
  cwd.setAttribute("aria-label", t("工作目录（选填）", "Working directory (optional)"));
  cwd.placeholder = t("留空使用 Desktop 默认工作区", "Leave blank for a Desktop workspace");
  advanced.append(
    advancedSummary,
    field(t("工作目录（选填）", "Working directory (optional)"), cwd),
  );
  const name = el("input", fieldClass);
  name.name = "name";
  name.autocomplete = "off";
  name.setAttribute("aria-label", t("名称", "Name"));
  name.maxLength = 256;
  const nameField = field(t("名称", "Name"), name);
  nameField.hidden = !editing;
  name.required = Boolean(editing);
  const complexNote = el(
    "p",
    "m-0 text-sm text-settings-muted",
    t(
      "此任务使用自定义周期。名称和正文可以修改，时间请在官方任务列表编辑。",
      "This task uses a custom schedule. Edit its time in the official task list; name and task remain editable here.",
    ),
  );
  complexNote.hidden = !editing || initialTime !== null;
  fields.append(
    nameField,
    row,
    field(t("任务内容", "Task"), prompt),
    schedule,
    complexNote,
    el(
      "p",
      "m-0 text-xs leading-5 text-settings-muted",
      `${Intl.DateTimeFormat().resolvedOptions().timeZone} · ${t("Desktop 运行时按原生规则触发；审批仍需处理。", "Uses Desktop scheduling while running; approvals still require your response.")}`,
    ),
    advanced,
  );
  const submit = el(
    "button",
    `${buttonClass} self-start`,
    editing ? t("保存修改", "Save changes") : t("创建", "Create"),
  );
  submit.type = "submit";
  submit.disabled = true;
  const status = el(
    "p",
    "m-0 break-words text-sm text-settings-muted",
    t("正在连接 Desktop…", "Connecting to Desktop…"),
  );
  status.setAttribute("role", "status");
  const actions = el("div", "flex flex-wrap gap-3");
  const back = el(
    "button",
    "min-h-9 self-start rounded-lg border-0 bg-transparent px-3 py-2 text-sm text-settings-muted hover:bg-settings-hover hover:text-settings-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:opacity-50",
    t("返回列表", "Back to list"),
  );
  back.type = "button";
  back.addEventListener("click", options.onBack);
  form.append(fields, submit, back);
  root.append(form, status, actions);
  content.append(root);
  const session: DesktopHarnessScheduleSession | null = editing
    ? null
    : options.connection.createSession();
  let models: HarnessModel[] = [];
  let pending = false;
  let finished = false;
  let lockedInput: HarnessScheduleInput | null = null;
  let client: RendererModelClient | null = null;
  const update = () => {
    back.disabled = pending;
    submit.disabled =
      pending ||
      finished ||
      (!editing && (!session || !harness.value || !models.some((m) => m.ref.id === model.value)));
  };
  const loadModels = () => {
    models = [];
    model.replaceChildren();
    model.disabled = true;
    update();
    if (!client || !harness.value) return;
    const selected = harness.value as HarnessId;
    const selectedClient = client;
    status.textContent = t("正在读取模型…", "Loading models…");
    void context.runLatest(
      () =>
        selectedClient.inspectHarness({
          harnessId: selected,
          ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
        }),
      {
        success(inspection) {
          if (inspection.status !== "ready") {
            status.textContent = t(
              "所选 Harness 当前不可用。",
              "The selected Harness is unavailable.",
            );
            return;
          }
          models = inspection.catalog.models;
          for (const item of models) model.append(new Option(item.label, item.ref.id));
          if (
            inspection.catalog.defaultModel &&
            models.some((m) => m.ref.id === inspection.catalog.defaultModel?.id)
          )
            model.value = inspection.catalog.defaultModel.id;
          model.disabled = models.length === 0;
          status.textContent = models.length ? "" : t("没有可用模型。", "No models are available.");
          update();
        },
        failure() {
          status.textContent = t("无法读取模型目录。", "Could not read the Model catalog.");
        },
      },
    );
  };
  harness.addEventListener("change", loadModels);
  cwd.addEventListener("change", loadModels);
  model.addEventListener("change", update);
  const finish = (result: HarnessScheduleResult, input?: HarnessScheduleInput): void => {
    pending = false;
    if (result.threadId && input) lockedInput = input;
    finished = result.outcome !== "failed" || !result.retryable;
    fields.disabled = editing ? finished : lockedInput !== null;
    status.textContent =
      result.outcome === "saved"
        ? t(editing ? "已保存修改。" : "已创建。", editing ? "Changes saved." : "Created.")
        : result.outcome === "unknown"
          ? t(
              "结果尚未确认，请返回列表刷新核对，勿重复提交。",
              "Outcome unconfirmed. Return to the list and refresh before submitting again.",
            )
          : `${t("操作未完成。", "Operation did not finish.")} ${result.message ?? ""}`;
    if (result.outcome === "saved") {
      options.onDone(status.textContent ?? "");
      return;
    }
    submit.textContent = t("重试", "Retry");
    actions.replaceChildren();
    const createdThreadId = result.threadId;
    if (createdThreadId && openThread) {
      const open = el("button", buttonClass, t("打开聊天", "Open chat"));
      open.type = "button";
      open.addEventListener("click", () => {
        void openThread(createdThreadId, signal).catch(() => {
          if (!signal.aborted)
            status.textContent = t(
              "无法打开聊天，请从侧栏进入。",
              "Open this chat from the sidebar.",
            );
        });
      });
      actions.append(open);
    }
    update();
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled || pending || !form.reportValidity()) return;
    if (editing) {
      const edit: HarnessScheduleEdit = {};
      if (name.value !== editing.name) edit.name = name.value;
      if (prompt.value !== editing.prompt) edit.prompt = prompt.value;
      const [hour = Number.NaN, minute = Number.NaN] = time.value.split(":").map(Number);
      const changedTime = {
        frequency: frequency.value as "daily" | "weekly",
        hour,
        minute,
        weekday: frequency.value === "daily" ? 1 : Number(weekday.value),
      };
      if (
        initialTime &&
        (changedTime.frequency !== initialTime.frequency ||
          changedTime.hour !== initialTime.hour ||
          changedTime.minute !== initialTime.minute ||
          changedTime.weekday !== initialTime.weekday)
      )
        edit.schedule = changedTime;
      pending = true;
      fields.disabled = true;
      update();
      status.textContent = t("正在保存…", "Saving…");
      void context.runLatest(
        (requestSignal) => options.connection.update(editing, edit, requestSignal),
        {
          success: (result) => finish(result),
          failure: () => finish({ outcome: "unknown", retryable: false }),
        },
      );
      return;
    }
    if (!session) return;
    const [hour = Number.NaN, minute = Number.NaN] = time.value.split(":").map(Number);
    const activeSession = session;
    const selectedModel = models.find((m) => m.ref.id === model.value);
    if (!selectedModel) return;
    const input: HarnessScheduleInput = lockedInput ?? {
      harnessId: harness.value as HarnessId,
      model: selectedModel.ref,
      prompt: prompt.value,
      cwd: cwd.value.trim(),
      frequency: frequency.value as "daily" | "weekly",
      hour,
      minute,
      weekday: Number(weekday.value),
    };
    pending = true;
    fields.disabled = true;
    update();
    status.textContent = t(
      "正在创建；离开页面只会停止等待，不保证撤销操作。",
      "Creating. Leaving this page stops waiting and may not cancel submitted operations.",
    );
    void context.runLatest((requestSignal) => activeSession.submit(input, requestSignal), {
      success: (result) => finish(result, input),
      failure() {
        pending = false;
        finished = true;
        status.textContent = t(
          "结果未知，请先核对官方任务列表。",
          "Outcome unknown. Check the official task list.",
        );
        update();
      },
    });
  });
  if (editing) {
    row.hidden = advanced.hidden = true;
    harness.required = model.required = false;
    harness.disabled = model.disabled = cwd.disabled = true;
    name.value = editing.name;
    prompt.value = editing.prompt;
    schedule.hidden = !initialTime;
    if (initialTime) {
      frequency.value = initialTime.frequency;
      time.value = `${String(initialTime.hour).padStart(2, "0")}:${String(initialTime.minute).padStart(2, "0")}`;
      weekday.value = String(initialTime.weekday);
      dayField.hidden = initialTime.frequency !== "weekly";
    }
    status.textContent = "";
    update();
    return;
  }
  harness.disabled = true;
  void context.runLatest(
    async () => {
      client = options.getModelClient();
      if (!client?.listHarnessPlugins) throw new Error("Local Harness catalog unavailable");
      return client.listHarnessPlugins();
    },
    {
      success(directory) {
        for (const plugin of directory.plugins.filter((p) => p.kind !== "usage"))
          harness.append(new Option(plugin.name, plugin.id));
        harness.disabled = false;
        status.textContent = t(
          "选择本次任务使用的 Harness 和 Model。",
          "Choose the Harness and Model for this task.",
        );
        update();
      },
      failure(error) {
        status.textContent = `${t("无法读取 Harness 目录。", "Harness catalog unavailable.")} ${error instanceof Error ? error.message : ""}`;
      },
    },
  );
}
