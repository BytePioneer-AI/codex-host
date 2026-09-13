import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

/** Same key as the Cursor composer picker. */
const HIDDEN_MODELS_KEY = "codexhost.cursor-model-picker-hidden.v1";

function hiddenModelIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MODELS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function setModelHidden(modelId: string, hidden: boolean): void {
  const ids = hiddenModelIds();
  if (hidden) ids.add(modelId);
  else ids.delete(modelId);
  try {
    window.localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...ids]));
  } catch {
    // Private mode or quota.
  }
}

export interface RendererCursorModelOption {
  readonly id: string;
  readonly label: string;
}

export interface RendererCursorModelsClient {
  listModels(): Promise<readonly RendererCursorModelOption[]>;
}

export function createModelsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCursorModelsClient | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "models",
    label: messages.pageLabels.models,
    icon: "model-pool",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.models;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.modelsDescription;

      const search = document.createElement("input");
      search.type = "search";
      search.className = "settings-models-search";
      search.placeholder = messages.modelsSearchPlaceholder;
      search.setAttribute("aria-label", messages.modelsSearchPlaceholder);

      const list = document.createElement("div");
      list.className = "settings-models-list";

      const status = document.createElement("p");
      status.className = "settings-page-description";

      context.content.append(heading, description, search, list, status);

      const renderUnavailable = (detail: string): void => {
        list.replaceChildren();
        status.hidden = false;
        status.textContent = detail;
        search.hidden = true;
      };

      const renderModels = (models: readonly RendererCursorModelOption[]): void => {
        search.hidden = models.length === 0;
        status.hidden = models.length > 0;
        status.textContent = models.length === 0 ? messages.modelsEmpty : "";
        const query = search.value.trim().toLowerCase();
        list.replaceChildren();
        for (const model of models) {
          const haystack = `${model.label} ${model.id}`.toLowerCase();
          if (query.length > 0 && !haystack.includes(query)) continue;
          const row = document.createElement("div");
          row.className = "settings-models-row";
          const title = document.createElement("span");
          title.className = "settings-models-row__label";
          title.textContent = model.label;
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "settings-preference-switch";
          const visible = !hiddenModelIds().has(model.id);
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-checked", String(visible));
          toggle.setAttribute("aria-label", model.label);
          const thumb = document.createElement("span");
          thumb.className = "settings-preference-switch__thumb";
          toggle.append(thumb);
          toggle.addEventListener("click", () => {
            const nextVisible = toggle.getAttribute("aria-checked") !== "true";
            toggle.setAttribute("aria-checked", String(nextVisible));
            setModelHidden(model.id, !nextVisible);
          });
          row.append(title, toggle);
          list.append(row);
        }
      };

      let models: readonly RendererCursorModelOption[] = [];
      search.addEventListener("input", () => renderModels(models));

      const load = (): Promise<void> => {
        const client = getClient();
        if (!client) {
          renderUnavailable(messages.modelsUnavailable);
          return Promise.resolve();
        }
        status.hidden = false;
        status.textContent = messages.modelsLoading;
        list.replaceChildren();
        return context.runLatest((_signal) => client.listModels(), {
          success(result) {
            models = result;
            renderModels(models);
          },
          failure() {
            renderUnavailable(messages.modelsLoadFailed);
          },
        });
      };

      void load();
      return undefined;
    },
  });
}
