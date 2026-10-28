import {
  nativeScheduleModelRows,
  readNativeScheduleForm,
  type NativeScheduleModel,
} from "@codexhost/desktop-control/renderer-bindings";
import {
  encodeHarnessPluginRoute,
  type HarnessId,
  type HarnessModel,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";
import { createRendererAgentIcon } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  createSchedulePicker,
  schedulePickerStyles,
  type SchedulePickerItem,
} from "./renderer-native-schedule-picker.js";

type ModelClient = Pick<RendererModelClient, "inspectHarness">;
type ModelRow = ReturnType<typeof nativeScheduleModelRows>[number];
type RowAppearance = { hidden: boolean; display: string; priority: string };
function restoreRow(row: ModelRow, appearance: RowAppearance) {
  row.hidden = appearance.hidden;
  row.style.setProperty("display", appearance.display, appearance.priority);
}
export interface NativeScheduleControlsOptions {
  getClient(): ModelClient | null;
  /** Already confirmed ready in the current local connection's cache. Never probes. */
  getAvailablePlugins(): readonly HarnessPluginDescriptor[];
  subscribeAvailability(listener: () => void): () => void;
  canRouteExternal(): boolean;
  locale(): string;
}

/** Adds selection only. Desktop owns the form, validation, creation, setup Turn,
 * schedule writes and navigation. No interception or replay of native writes.
 */
export function installRendererNativeScheduleControls(
  document: Document,
  options: NativeScheduleControlsOptions,
) {
  const view = document.defaultView ?? window;
  const mounted = new Map<HTMLFormElement, ReturnType<typeof mount>>();
  let disposed = false;
  let frame: number | null = null;
  const text = (zh: string, en: string) => (options.locale() === "zh-CN" ? zh : en);
  const schedule = () => {
    if (!disposed && frame === null) frame = view.requestAnimationFrame(scan);
  };
  function mount(form: HTMLFormElement) {
    const root = document.createElement("div");
    root.dataset.codexhostScheduleControls = "true";
    // Shadow controls are not native form fields; React retains the task form.
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; contain:inline-size; margin:0 0 16px; color:inherit; font:inherit; --text:var(--color-text-primary,CanvasText); --muted:var(--color-text-secondary,light-dark(#6b6b6b,#b5b5b5)); --border:var(--color-border-default,light-dark(#e1e1e1,#454545)); --hover:var(--color-token-list-hover-background,light-dark(rgba(0,0,0,.05),rgba(255,255,255,.08))); --surface:var(--color-token-dropdown-background,var(--color-background-surface,Canvas)); --focus:var(--color-text-info,#387aff); }
      * { box-sizing:border-box; }
      fieldset { border:1px solid var(--border); border-radius:16px; padding:0 12px; margin:0; min-width:0; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:16px; min-width:0; min-height:52px; padding:8px 0 8px 4px; font:inherit; }
      .row + .row { border-top:1px solid var(--border); }
      .name { flex:none; }
      .value { display:flex; justify-content:flex-end; min-width:0; max-width:72%; }
      fieldset:disabled { opacity:.6; }
      ${schedulePickerStyles}
      .message { display:flex; align-items:baseline; gap:8px; margin:8px 4px 0; color:var(--muted); font-size:12px; line-height:1.5; }
      p { margin:0; min-width:0; overflow-wrap:anywhere; }
      button.retry { border:0; border-radius:4px; padding:2px 4px; color:inherit; background:transparent; font:inherit; text-decoration:underline; cursor:pointer; flex-shrink:0; }
      button.retry:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
      [hidden] { display:none!important; }
    `;
    const fields = document.createElement("fieldset");
    const harness = createSchedulePicker(document, {
      label: "Harness",
      listLabel: text("选择 Harness", "Choose a Harness"),
      retainMissing: true,
      onChange: () => onHarness(),
    });
    const model = createSchedulePicker(document, {
      label: text("模型", "Model"),
      listLabel: text("选择模型", "Choose a Model"),
      onChange: () => applyModel(),
    });
    const label = (name: string, picker: { root: HTMLElement }) => {
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("span");
      title.className = "name";
      title.textContent = name;
      const value = document.createElement("div");
      value.className = "value";
      value.append(picker.root);
      row.append(title, value);
      fields.append(row);
      return row;
    };
    label("Harness", harness);
    const modelRow = label(text("模型", "Model"), model);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = text("重试", "Retry");
    retry.hidden = true;
    const messageRow = document.createElement("div");
    messageRow.className = "message";
    messageRow.append(status, retry);
    shadow.append(style, fields, messageRow);
    const editor = form.querySelector('[contenteditable="true"][role="textbox"], textarea');
    const container = editor?.closest("fieldset")?.querySelector(":scope > div") ?? form;
    container.prepend(root);
    let retired = false;
    let client = options.getClient();
    let selectedHarness = "codex";
    let availablePlugins: readonly HarnessPluginDescriptor[] = [];
    let generation = 0;
    let loading = false;
    let confirming = false;
    let confirmationTimer: number | undefined;
    let error = "";
    let models: HarnessModel[] = [];
    let carrier: string | null = null;
    let original: NativeScheduleModel | null = null;
    let restoring: NativeScheduleModel | null = null;
    const hiddenRows = new Map<ModelRow, RowAppearance>();
    const external = () => selectedHarness !== "codex";
    const available = () =>
      options.getAvailablePlugins().some((plugin) => plugin.id === selectedHarness);
    const harnessItem = (
      id: string,
      name: string,
      plugin?: HarnessPluginDescriptor,
    ): SchedulePickerItem => ({
      value: id,
      label: name,
      icon: createRendererAgentIcon(id, 18, document, plugin),
    });
    // A cold cache has no external plugins, and sync skips an unchanged empty list.
    harness.setItems([harnessItem("codex", "Codex")]);
    harness.value = "codex";
    const syncAvailablePlugins = () => {
      const next = options.getAvailablePlugins();
      if (
        next.length === availablePlugins.length &&
        next.every(
          (plugin, index) =>
            plugin.id === availablePlugins[index]?.id &&
            plugin.name === availablePlugins[index]?.name,
        )
      )
        return;
      availablePlugins = next;
      harness.setItems([
        harnessItem("codex", "Codex"),
        ...next.map((plugin) => harnessItem(plugin.id, plugin.name, plugin)),
      ]);
      // A disappeared selection is not an implicit switch to Codex.
      harness.value = selectedHarness;
    };
    const cancelConfirmation = () => {
      if (confirmationTimer !== undefined) view.clearTimeout(confirmationTimer);
      confirmationTimer = undefined;
      confirming = false;
    };
    const restoredSelection = (selection: NativeScheduleModel) =>
      restoring &&
      (restoring.model === null
        ? !selection.model?.startsWith("codexhost/")
        : selection.model === restoring.model &&
          selection.reasoningEffort === restoring.reasoningEffort);
    // React can commit a draft Model without changing any DOM (Advanced closed).
    // Briefly read committed props; never replay the setter or schedule writes.
    const confirmSelection = () => {
      cancelConfirmation();
      confirming = true;
      const deadline = Date.now() + 5000;
      const check = () => {
        if (retired) return;
        const binding = readNativeScheduleForm(form);
        const confirmed =
          binding &&
          (external()
            ? binding.selection.model === carrier
            : !restoring || restoredSelection(binding.selection));
        if (
          !binding ||
          !options.canRouteExternal() ||
          client !== options.getClient() ||
          confirmed ||
          Date.now() >= deadline
        )
          cancelConfirmation();
        else confirmationTimer = view.setTimeout(check, 50);
        update();
      };
      confirmationTimer = view.setTimeout(check, 0);
    };
    const restore = () => {
      const binding = readNativeScheduleForm(form);
      if (original && carrier && (!binding || binding.selection.model === carrier || confirming)) {
        restoring = original;
        binding?.setModel(original);
        confirmSelection();
      }
      carrier = null;
      original = null;
    };
    const applyModel = () => {
      const binding = readNativeScheduleForm(form);
      const selected = models.find((entry) => entry.ref.id === model.value);
      if (
        !external() ||
        !binding?.supportsExternal ||
        !available() ||
        binding.hasTarget ||
        binding.isSaving ||
        !selected
      )
        return;
      original ??= restoring ?? binding.selection;
      restoring = null;
      carrier = encodeHarnessPluginRoute({
        harnessId: selectedHarness as HarnessId,
        model: selected.ref,
      });
      binding.setModel({ model: carrier, reasoningEffort: null });
      confirmSelection();
      update();
    };
    const loadModels = async () => {
      const request = ++generation;
      cancelConfirmation();
      models = [];
      model.setItems([]);
      model.value = "";
      model.setPlaceholder(text("正在加载模型…", "Loading models…"), true);
      error = "";
      loading = true;
      update();
      const requestedHarness = selectedHarness;
      const selectedClient = client;
      try {
        if (!selectedClient) throw Error(text("本地连接不可用。", "Local connection unavailable."));
        const result = await selectedClient.inspectHarness({
          harnessId: requestedHarness as HarnessId,
        });
        if (retired || request !== generation || selectedClient !== options.getClient()) return;
        if (result.status !== "ready")
          throw Error(text("所选 Harness 不可用。", "The selected Harness is unavailable."));
        models = result.catalog.models;
        model.setItems(models.map((entry) => ({ value: entry.ref.id, label: entry.label })));
        const defaultModel = result.catalog.defaultModel;
        model.value =
          defaultModel && models.some((entry) => entry.ref.id === defaultModel.id)
            ? defaultModel.id
            : (models[0]?.ref.id ?? "");
        model.setPlaceholder("");
        if (!models.length) throw Error(text("没有可用模型。", "No models are available."));
        applyModel();
      } catch (cause) {
        if (retired || request !== generation) return;
        error =
          cause instanceof Error ? cause.message : text("模型读取失败。", "Could not read models.");
        model.setPlaceholder(text("模型加载失败", "Models unavailable"));
      } finally {
        if (!retired && request === generation) {
          loading = false;
          update();
        }
      }
    };
    const onHarness = () => {
      const binding = readNativeScheduleForm(form);
      if (binding?.hasTarget || binding?.isSaving) return;
      selectedHarness = harness.value;
      client = options.getClient();
      if (!external()) restore();
      generation++;
      models = [];
      model.setItems([]);
      model.value = "";
      model.setPlaceholder("");
      error = "";
      loading = false;
      if (external()) void loadModels();
      update();
    };
    retry.addEventListener("click", () => {
      if (error) void loadModels();
      else applyModel();
    });
    function blockedReason(): string {
      const binding = readNativeScheduleForm(form);
      if (!external()) {
        // A null native Model delegates to Desktop's current default. Its
        // render-time normalization may already have filled Model and Effort.
        const restored = binding && restoredSelection(binding.selection);
        if (restoring && !restored)
          return text(
            "正在恢复 Codex 配置，请稍后提交。",
            "Restoring Codex settings. Submit again once ready.",
          );
        restoring = null;
        if (binding?.selection.model?.startsWith("codexhost/"))
          return text(
            "任务仍携带外部 Model，请重新打开弹窗。",
            "The task still carries an external Model. Reopen the dialog.",
          );
        return "";
      }
      if (!binding || !options.canRouteExternal() || client !== options.getClient())
        return text(
          "任务接入或本地连接不可用，请重新打开弹窗。",
          "Task binding or local connection unavailable. Reopen the dialog.",
        );
      if (!available())
        return text(
          "所选 Harness 已不在本地可用列表中，请重新选择。",
          "The selected Harness is no longer available locally. Choose another Harness.",
        );
      if (!binding.supportsExternal)
        return text(
          "外部 Harness 仅支持本地固定聊天：请启用“在此电脑上运行”，关闭“每次运行都开启新聊天”，并选择个人定时任务。",
          "External Harnesses require a personal local task in the same chat. Enable Run on this computer and disable Start each run in new chat.",
        );
      if (error) return error;
      if (loading || !carrier || !models.some((entry) => entry.ref.id === model.value))
        return text("请等待并选择可用的 Model。", "Wait for an available Model and select it.");
      if (binding.selection.model !== carrier && confirming)
        return text("正在应用模型…", "Applying Model…");
      if (binding.selection.model !== carrier)
        return text(
          "任务的 Model 尚未确认，请重新选择 Model。",
          "The task Model is not confirmed. Select the Model again.",
        );
      return "";
    }
    function update() {
      if (retired) return;
      syncAvailablePlugins();
      const binding = readNativeScheduleForm(form);
      const active = external();
      modelRow.hidden = !active;
      fields.disabled = Boolean(binding?.isSaving || binding?.hasTarget);
      const modelBusy = loading || (confirming && active);
      model.disabled =
        modelBusy || models.length === 0 || !binding?.supportsExternal || !available();
      model.busy = modelBusy;
      harness.busy = confirming && !active;
      harness.disabled = fields.disabled;
      const externalBlocked = !binding?.supportsExternal || !options.canRouteExternal();
      harness.setDisabledValues(externalBlocked ? (id) => id !== "codex" : () => false);
      const blocked = blockedReason();
      const message =
        loading || confirming
          ? ""
          : active
            ? blocked
            : blocked ||
              error ||
              (!binding?.supportsExternal
                ? text(
                    "外部 Harness 需要在高级设置中选择本地、固定聊天。",
                    "For external Harnesses, choose local execution in the same chat under Advanced.",
                  )
                : "");
      if (status.textContent !== message) status.textContent = message;
      messageRow.hidden = !message;
      retry.hidden =
        !active ||
        !message ||
        !binding?.supportsExternal ||
        Boolean(binding.hasTarget || binding.isSaving) ||
        client !== options.getClient() ||
        !options.canRouteExternal() ||
        !available();
      const rows = active ? new Set(nativeScheduleModelRows(form)) : new Set<ModelRow>();
      for (const [row, appearance] of hiddenRows) {
        if (rows.has(row)) continue;
        restoreRow(row, appearance);
        hiddenRows.delete(row);
      }
      for (const row of rows) {
        if (!hiddenRows.has(row))
          hiddenRows.set(row, {
            hidden: row.hidden,
            display: row.style.getPropertyValue("display"),
            priority: row.style.getPropertyPriority("display"),
          });
        row.hidden = true;
        // Desktop's flex/grid classes override the user-agent [hidden] rule.
        row.style.setProperty("display", "none", "important");
      }
    }
    const onSubmit = (event: Event) => {
      const reason = blockedReason();
      if (!reason) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      messageRow.hidden = loading || confirming;
      status.textContent = reason;
    };
    // Guard before React's delegated submit handler. Never call onSubmit ourselves.
    form.addEventListener("submit", onSubmit, true);
    update();
    return {
      root,
      update,
      dispose() {
        retired = true;
        generation++;
        if (form.isConnected) restore();
        cancelConfirmation();
        harness.close();
        model.close();
        for (const [row, appearance] of hiddenRows) restoreRow(row, appearance);
        form.removeEventListener("submit", onSubmit, true);
        root.remove();
      },
    };
  }
  function scan() {
    frame = null;
    if (disposed) return;
    for (const [form, control] of mounted) {
      if (!form.isConnected || !control.root.isConnected) {
        control.dispose();
        mounted.delete(form);
      } else control.update();
    }
    for (const form of document.querySelectorAll<HTMLFormElement>('form[data-density="form"]')) {
      if (!mounted.has(form) && readNativeScheduleForm(form)) mounted.set(form, mount(form));
    }
  }
  const unsubscribeAvailability = options.subscribeAvailability(schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("change", schedule, true);
  document.addEventListener("click", schedule, true);
  view.addEventListener("codexhost:draft-prewarm-policy-changed", schedule);
  scan();
  return {
    refresh: schedule,
    dispose() {
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribeAvailability();
      document.removeEventListener("change", schedule, true);
      document.removeEventListener("click", schedule, true);
      view.removeEventListener("codexhost:draft-prewarm-policy-changed", schedule);
      for (const control of mounted.values()) control.dispose();
      mounted.clear();
    },
  };
}
