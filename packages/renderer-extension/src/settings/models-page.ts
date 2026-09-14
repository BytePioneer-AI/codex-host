import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export type RendererVisibleModelHarness = "cursor-cli" | "pi";

const HIDDEN_MODEL_KEYS: Record<RendererVisibleModelHarness, string> = {
  "cursor-cli": "codexhost.cursor-model-picker-hidden.v1",
  pi: "codexhost.pi-model-picker-hidden.v1",
};

function hiddenModelIds(harness: RendererVisibleModelHarness): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MODEL_KEYS[harness]);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function setModelHidden(
  harness: RendererVisibleModelHarness,
  modelId: string,
  hidden: boolean,
): void {
  const ids = hiddenModelIds(harness);
  if (hidden) ids.add(modelId);
  else ids.delete(modelId);
  try {
    window.localStorage.setItem(HIDDEN_MODEL_KEYS[harness], JSON.stringify([...ids]));
  } catch {
    // Private mode or quota.
  }
}

export interface RendererCursorModelOption {
  readonly id: string;
  readonly label: string;
}

export interface RendererCursorModelsClient {
  listModels(harnessId: RendererVisibleModelHarness): Promise<readonly RendererCursorModelOption[]>;
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
      const header = document.createElement("div");
      header.className = "settings-models-header";
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.models;
      const harnessBar = document.createElement("div");
      harnessBar.className = "settings-models-harness";
      harnessBar.setAttribute("role", "tablist");
      harnessBar.setAttribute("aria-label", messages.sessionImportHarness);
      header.append(heading, harnessBar);

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

      context.content.append(header, description, search, list, status);

      const sections: {
        harness: RendererVisibleModelHarness;
        title: string;
        models: readonly RendererCursorModelOption[] | undefined;
        error?: string;
      }[] = [
        { harness: "cursor-cli", title: messages.modelsCursorSection, models: undefined },
        { harness: "pi", title: messages.modelsPiSection, models: undefined },
      ];
      let selectedHarness: RendererVisibleModelHarness = "cursor-cli";

      const selectedSection = (): (typeof sections)[number] =>
        sections.find((section) => section.harness === selectedHarness) ?? sections[0]!;

      const renderHarnessOptions = (): void => {
        harnessBar.replaceChildren();
        for (const section of sections) {
          const option = document.createElement("button");
          option.type = "button";
          option.textContent = section.title;
          option.setAttribute("role", "tab");
          option.setAttribute("aria-selected", String(section.harness === selectedHarness));
          option.addEventListener("click", () => {
            if (section.harness === selectedHarness) return;
            selectedHarness = section.harness;
            search.value = "";
            renderHarnessOptions();
            void load();
          });
          harnessBar.append(option);
        }
      };

      const renderUnavailable = (detail: string): void => {
        list.replaceChildren();
        status.hidden = false;
        status.textContent = detail;
        search.hidden = true;
      };

      const renderModels = (): void => {
        const section = selectedSection();
        if (section.error) {
          renderUnavailable(section.error);
          return;
        }
        const models = section.models ?? [];
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
          const visible = !hiddenModelIds(section.harness).has(model.id);
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-checked", String(visible));
          toggle.setAttribute("aria-label", model.label);
          const thumb = document.createElement("span");
          thumb.className = "settings-preference-switch__thumb";
          toggle.append(thumb);
          toggle.addEventListener("click", () => {
            const nextVisible = toggle.getAttribute("aria-checked") !== "true";
            toggle.setAttribute("aria-checked", String(nextVisible));
            setModelHidden(section.harness, model.id, !nextVisible);
          });
          row.append(title, toggle);
          list.append(row);
        }
      };

      search.addEventListener("input", () => renderModels());

      const load = (): Promise<void> => {
        const client = getClient();
        if (!client) {
          renderUnavailable(messages.modelsUnavailable);
          return Promise.resolve();
        }
        const section = selectedSection();
        if (section.models || section.error) {
          renderModels();
          return Promise.resolve();
        }
        status.hidden = false;
        status.textContent = messages.modelsLoading;
        list.replaceChildren();
        const harness = section.harness;
        return context.runLatest((_signal) => client.listModels(harness), {
          success(result) {
            if (selectedSection().harness !== harness) return;
            section.models = result;
            delete section.error;
            renderModels();
          },
          failure() {
            if (selectedSection().harness !== harness) return;
            section.models = [];
            section.error = messages.modelsLoadFailed;
            renderUnavailable(section.error);
          },
        });
      };

      renderHarnessOptions();

      void load();
      return undefined;
    },
  });
}
