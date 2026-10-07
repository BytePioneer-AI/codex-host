import {
  MODEL_PRICE_DEFAULT_METHOD,
  MODEL_PRICE_OVERRIDES_GET_METHOD,
  MODEL_PRICE_OVERRIDES_SET_METHOD,
  modelPriceDefaultResultSchema,
  modelPriceOverridesSchema,
  type ModelPriceOverride,
  type ModelPriceOverrides,
  type ModelPriceOverridesSet,
} from "@codexhost/shared-contracts";

import { button, h } from "./dom.js";
import type { ConsoleMessages } from "./messages.js";
import {
  MODEL_PRICE_FIELDS,
  modelPriceChange,
  modelPriceDraft,
  type ModelPriceDraftError,
  type ModelPriceField,
} from "./model-price-form.js";

type HostRequest = (method: string, params: unknown) => Promise<unknown>;
type Messages = ConsoleMessages["modelPrices"];

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => values[name] ?? match);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPrice(messages: Messages, price: ModelPriceOverride): string {
  return MODEL_PRICE_FIELDS.map(
    (field) => `${messages.fields[field]} ${price[field] ?? messages.unset}`,
  ).join(" · ");
}

function draftErrorText(messages: Messages, error: ModelPriceDraftError): string {
  return fill(messages.errors[error.kind], {
    key: "key" in error ? error.key : "",
    field: "field" in error ? messages.fields[error.field] : "",
  });
}

/** Row-scoped editor. The Host owns persistence; statistics polling never replaces this dialog. */
export function createModelPricesDialog(
  document: Document,
  consoleMessages: ConsoleMessages,
  request: HostRequest,
  signal: AbortSignal,
  onChange: () => void,
): { element: HTMLDialogElement; edit(model: string): void } {
  const messages = consoleMessages.modelPrices;
  const element = h(document, "dialog", {
    className: "console-model-prices",
    "aria-label": messages.label,
  });
  let generation = 0;
  let busy = false;
  const close = (): void => {
    generation++;
    busy = false;
    element.close();
    element.replaceChildren();
  };
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!busy) close();
  });
  signal.addEventListener("abort", close, { once: true });

  function edit(modelId: string): void {
    if (signal.aborted || element.open) return;
    const current = ++generation;
    const isCurrent = (): boolean => !signal.aborted && element.open && current === generation;
    const heading = h(document, "h2", { className: "console-panel__title" }, messages.label);
    const status = h(
      document,
      "p",
      { className: "console-muted", role: "status" },
      messages.loading,
    );
    const cancel = button(document, messages.cancel, close);
    const body = h(
      document,
      "div",
      { className: "console-model-prices__body" },
      heading,
      status,
      cancel,
    );
    element.replaceChildren(body);
    element.showModal();
    // Independent of the statistics request: closing/reopening invalidates late responses.
    void request(MODEL_PRICE_OVERRIDES_GET_METHOD, {})
      .then((value) => {
        if (!isCurrent()) return;
        const view = modelPriceOverridesSchema.parse(value);
        if (view.error !== null) {
          status.setAttribute("role", "alert");
          status.textContent = fill(messages.invalidFile, { error: view.error });
          return;
        }
        renderEditor(modelId, view, isCurrent);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        status.setAttribute("role", "alert");
        status.textContent = message(error);
      });
  }

  function renderEditor(
    modelId: string,
    view: ModelPriceOverrides,
    isCurrent: () => boolean,
  ): void {
    const existing = view.entries.find((entry) => entry.key === modelId);
    const draft = modelPriceDraft(modelId, existing?.price ?? null);
    const field = (label: string, value: string, placeholder = ""): HTMLInputElement =>
      h(document, "input", {
        type: "text",
        className: "console-input",
        value,
        placeholder,
        "aria-label": label,
      });
    const model = field(messages.model, modelId);
    // The action belongs to this model row, not a separate model-management page.
    model.readOnly = true;
    const prices = Object.fromEntries(
      MODEL_PRICE_FIELDS.map((name) => {
        const input = field(
          messages.fields[name],
          draft.prices[name],
          name === "input" || name === "output" ? messages.required : messages.notSet,
        );
        input.inputMode = "decimal";
        return [name, input];
      }),
    ) as Record<ModelPriceField, HTMLInputElement>;
    const error = h(document, "p", { className: "console-model-price__error", role: "alert" });
    const defaultInfo = h(document, "span", { className: "console-muted" });
    let defaultPrice: ModelPriceOverride | null = null;
    const useDefault = button(document, messages.useDefault, () => {
      if (!defaultPrice) return;
      for (const name of MODEL_PRICE_FIELDS)
        prices[name].value = defaultPrice[name]?.toString() ?? "";
    });
    useDefault.hidden = true;
    void request(MODEL_PRICE_DEFAULT_METHOD, { model: modelId })
      .then((value) => {
        if (!isCurrent()) return;
        defaultPrice = modelPriceDefaultResultSchema.parse(value).price;
        defaultInfo.textContent = defaultPrice
          ? fill(messages.defaultPrice, { price: formatPrice(messages, defaultPrice) })
          : messages.defaultMissing;
        useDefault.hidden = defaultPrice === null;
      })
      .catch(() => undefined);

    const cancel = button(document, messages.cancel, close);
    const save = button(document, messages.save, () => undefined, "primary");
    save.type = "submit";
    const remove = button(document, messages.remove, () => {
      confirmation.hidden = false;
      remove.hidden = true;
    });
    remove.hidden = !existing;
    const confirmRemove = button(
      document,
      messages.remove,
      () => void submit({ key: modelId, price: null }),
    );
    const cancelRemove = button(document, messages.cancel, () => {
      confirmation.hidden = true;
      remove.hidden = false;
    });
    const confirmation = h(
      document,
      "div",
      { className: "console-actions", hidden: true },
      h(
        document,
        "span",
        { className: "console-muted" },
        fill(messages.confirmRemove, { key: modelId }),
      ),
      confirmRemove,
      cancelRemove,
    );
    const controls = [
      save,
      cancel,
      model,
      useDefault,
      remove,
      confirmRemove,
      cancelRemove,
      ...Object.values(prices),
    ];
    async function submit(change: ModelPriceOverridesSet): Promise<void> {
      if (busy || !isCurrent()) return;
      busy = true;
      error.textContent = "";
      element.setAttribute("aria-busy", "true");
      for (const control of controls) control.disabled = true;
      save.textContent = messages.saving;
      try {
        modelPriceOverridesSchema.parse(await request(MODEL_PRICE_OVERRIDES_SET_METHOD, change));
        if (!isCurrent()) return;
        close();
        onChange();
      } catch (failure) {
        if (isCurrent()) error.textContent = message(failure);
      } finally {
        busy = false;
        element.removeAttribute("aria-busy");
        if (isCurrent()) {
          for (const control of controls) control.disabled = false;
          save.textContent = messages.save;
        }
      }
    }
    const labelled = (label: string, input: HTMLInputElement): HTMLElement =>
      h(
        document,
        "label",
        { className: "console-model-price__field" },
        h(document, "span", { className: "console-muted" }, label),
        input,
      );
    const form = h(
      document,
      "form",
      { className: "console-model-prices__body" },
      h(document, "h2", { className: "console-panel__title" }, messages.label),
      h(document, "p", { className: "console-muted" }, messages.unit),
      labelled(messages.model, model),
      h(
        document,
        "div",
        { className: "console-model-price__grid is-prices" },
        ...MODEL_PRICE_FIELDS.map((name) => labelled(messages.fields[name], prices[name])),
      ),
      h(document, "div", { className: "console-actions" }, defaultInfo, useDefault),
      h(document, "p", { className: "console-muted" }, messages.wholeEntry),
      error,
      confirmation,
      h(document, "div", { className: "console-actions" }, save, cancel, remove),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const result = modelPriceChange(
        {
          model: modelId,
          prices: Object.fromEntries(
            MODEL_PRICE_FIELDS.map((name) => [name, prices[name].value]),
          ) as Record<ModelPriceField, string>,
        },
        view.entries.map((entry) => entry.key),
        existing?.key,
      );
      if ("error" in result) {
        error.textContent = draftErrorText(messages, result.error);
        return;
      }
      // Preserve existing pricing settings that this editor does not expose.
      if (result.change.price && existing?.price.cacheWrite1h !== undefined) {
        result.change.price.cacheWrite1h = existing.price.cacheWrite1h;
      }
      void submit(result.change);
    });
    element.replaceChildren(form);
    prices.input.focus();
  }
  return { element, edit };
}
