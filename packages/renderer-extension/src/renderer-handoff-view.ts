import {
  catalogModelForRef,
  harnessModelRefFromKey,
  harnessModelRefKey,
  type HarnessModelCatalog,
  type HarnessPluginDescriptor,
  type HostThreadId,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";

import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import {
  formatRendererHandoffTurnsSummary,
  rendererHarnessMessages,
} from "./renderer-harness-localization.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ATTRIBUTE = "data-codexhost-handoff-style";

export const HANDOFF_POPOVER_WIDTH = 316;
export const HANDOFF_CONTROL_ATTRIBUTE = "data-codexhost-handoff-control";
export const HANDOFF_DIVIDER_ATTRIBUTE = "data-codexhost-handoff-divider";
export const HANDOFF_POPOVER_ATTRIBUTE = "data-codexhost-handoff-popover";

export interface HandoffDividerRenderOptions {
  ownerDocument: Document;
  handoff: ThreadHandoffMetadata;
  plugins?: readonly HarnessPluginDescriptor[];
  locale: RendererSettingsLocale;
  initiallyExpanded?: boolean;
  onOpenSourceThread(sourceThreadId: HostThreadId): void;
}

export interface HandoffPopoverViewOptions {
  ownerDocument: Document;
  locale: RendererSettingsLocale;
  harnesses: readonly { id: string; label: string; plugin?: HarnessPluginDescriptor | undefined }[];
  selectedHarnessId: string;
  catalog?: HarnessModelCatalog | undefined;
  loadingModels?: boolean | undefined;
  selectedModelId: string;
  selectedThinkingOptionId: string;
  submitting?: boolean | undefined;
  errorMessage?: string | null | undefined;
  onSelectHarness(harnessId: string): void;
  onSelectModel(modelId: string): void;
  onSelectThinking(thinkingOptionId: string): void;
  onConfirm(): void;
  onCancel(): void;
}

export function createSwapIcon(ownerDocument: Document, size = 14): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.45");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  for (const d of [
    "M2.75 5.25H13.25",
    "M10.75 2.75L13.25 5.25L10.75 7.75",
    "M13.25 10.75H2.75",
    "M5.25 8.25L2.75 10.75L5.25 13.25",
  ]) {
    const path = ownerDocument.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function createChevronIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("codexhost-handoff-divider-chevron");
  const path = ownerDocument.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4.5 6.25L8 9.75L11.5 6.25");
  svg.append(path);
  return svg;
}

function createCheckIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const path = ownerDocument.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3.5 8.5L6.5 11.5L12.5 4.75");
  svg.append(path);
  return svg;
}

function formatEndpointLabel(
  harnessId: string,
  harnessLabel: string | undefined,
  model: string | undefined,
  plugin: HarnessPluginDescriptor | undefined,
): string {
  const base = harnessLabel?.trim() || rendererAgentLabel(harnessId, plugin);
  const trimmedModel = model?.trim();
  if (!trimmedModel) return base;
  if (base.toLowerCase().includes(trimmedModel.toLowerCase())) return base;
  return `${base} (${trimmedModel})`;
}

export function ensureRendererHandoffStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [${HANDOFF_CONTROL_ATTRIBUTE}] {
      display: inline-flex;
      align-items: center;
      align-self: center;
      flex: 0 0 auto;
      margin-inline-end: 2px;
      color: inherit;
    }
    [${HANDOFF_DIVIDER_ATTRIBUTE}] {
      display: block;
      width: 100%;
      max-width: 780px;
      margin: 14px auto 16px;
      padding: 0 12px;
      box-sizing: border-box;
      color-scheme: inherit;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .codexhost-handoff-divider-row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
    }
    .codexhost-handoff-divider-line {
      flex: 1 1 auto;
      min-width: 24px;
      height: 1px;
      background: light-dark(rgba(15, 23, 42, 0.1), rgba(255, 255, 255, 0.11));
    }
    .codexhost-handoff-divider-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: min(100%, 640px);
      min-width: 0;
      padding: 4px 10px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: light-dark(#6b7280, #9ca3af);
      font: 400 12.5px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      transition: background-color 120ms ease;
    }
    .codexhost-handoff-divider-button:hover,
    .codexhost-handoff-divider-button[aria-expanded="true"] {
      background: light-dark(rgba(15, 23, 42, 0.045), rgba(255, 255, 255, 0.07));
    }
    .codexhost-handoff-divider-button:focus-visible {
      outline: 2px solid light-dark(#3b82f6, #60a5fa);
      outline-offset: 2px;
    }
    .codexhost-handoff-divider-title {
      color: light-dark(#6b7280, #9ca3af);
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .codexhost-handoff-endpoint {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      font-weight: 500;
    }
    .codexhost-handoff-endpoint--source {
      color: light-dark(#18181b, #ececec);
    }
    .codexhost-handoff-endpoint--target {
      color: light-dark(#4f79a8, #7cb3f0);
    }
    .codexhost-handoff-endpoint-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexhost-handoff-divider-arrow {
      color: light-dark(#9ca3af, #6b7280);
      font-size: 12px;
      flex: 0 0 auto;
    }
    .codexhost-handoff-divider-chevron {
      opacity: 0.55;
      flex: 0 0 auto;
      transition: transform 140ms ease;
    }
    .codexhost-handoff-divider-button[aria-expanded="true"] .codexhost-handoff-divider-chevron {
      transform: rotate(180deg);
    }
    .codexhost-handoff-detail {
      margin: 8px auto 0;
      max-width: 680px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.09), rgba(255, 255, 255, 0.1));
      background: light-dark(#f8f9fa, #1d1e22);
      color: light-dark(#18181b, #ececec);
      box-shadow: light-dark(0 4px 16px rgba(15, 23, 42, 0.05), 0 6px 20px rgba(0, 0, 0, 0.3));
      box-sizing: border-box;
    }
    .codexhost-handoff-detail[hidden] {
      display: none;
    }
    .codexhost-handoff-detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .codexhost-handoff-turns-summary {
      font-size: 12px;
      line-height: 1.45;
      color: light-dark(#52525b, #a1a1aa);
    }
    .codexhost-handoff-source-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
      background: light-dark(#ffffff, #27272a);
      color: light-dark(#18181b, #ececec);
      font: 500 12px/1.3 inherit;
      cursor: pointer;
    }
    .codexhost-handoff-source-btn:hover {
      background: light-dark(#f1f5f9, #323236);
    }
    .codexhost-handoff-preview-label {
      margin: 10px 0 6px;
      font-size: 11px;
      font-weight: 500;
      color: light-dark(#71717a, #9ca3af);
    }
    .codexhost-handoff-preview {
      margin: 0;
      padding: 10px 12px;
      max-height: 220px;
      overflow: auto;
      border-radius: 8px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.07), rgba(255, 255, 255, 0.08));
      background: light-dark(#ffffff, #141518);
      color: light-dark(#27272a, #d4d4d8);
      font: 400 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    [${HANDOFF_POPOVER_ATTRIBUTE}] {
      position: fixed;
      z-index: 2147483647;
      width: ${HANDOFF_POPOVER_WIDTH}px;
      max-width: calc(100vw - 16px);
      padding: 12px;
      border-radius: 14px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.12));
      background: light-dark(#ffffff, #1e1f23);
      color: light-dark(#18181b, #ececec);
      box-shadow: light-dark(0 12px 32px rgba(15, 23, 42, 0.14), 0 14px 36px rgba(0, 0, 0, 0.52));
      color-scheme: inherit;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-sizing: border-box;
    }
    .codexhost-handoff-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .codexhost-handoff-popover-title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      color: light-dark(#18181b, #f4f4f5);
    }
    .codexhost-handoff-popover-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: light-dark(#71717a, #a1a1aa);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    .codexhost-handoff-popover-close:hover {
      background: light-dark(rgba(15, 23, 42, 0.06), rgba(255, 255, 255, 0.08));
    }
    .codexhost-handoff-field-label {
      display: block;
      margin: 8px 0 5px;
      font-size: 11.5px;
      font-weight: 500;
      color: light-dark(#52525b, #a1a1aa);
    }
    .codexhost-handoff-harness-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 176px;
      overflow-y: auto;
    }
    .codexhost-handoff-harness-option {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 9px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: transparent;
      color: light-dark(#18181b, #ececec);
      font: 500 13px/1.25 inherit;
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }
    .codexhost-handoff-harness-option:hover:not(:disabled) {
      background: light-dark(rgba(15, 23, 42, 0.045), rgba(255, 255, 255, 0.06));
    }
    .codexhost-handoff-harness-option[aria-checked="true"] {
      background: light-dark(rgba(79, 121, 168, 0.1), rgba(124, 179, 240, 0.15));
      border-color: light-dark(rgba(79, 121, 168, 0.34), rgba(124, 179, 240, 0.34));
    }
    .codexhost-handoff-harness-option:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .codexhost-handoff-harness-name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexhost-handoff-harness-check {
      color: light-dark(#4f79a8, #7cb3f0);
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
    }
    .codexhost-handoff-select {
      width: 100%;
      height: 32px;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.14), rgba(255, 255, 255, 0.14));
      background: light-dark(#f8f9fa, #141518);
      color: light-dark(#18181b, #ececec);
      font: 400 12.5px/1.2 inherit;
      box-sizing: border-box;
    }
    .codexhost-handoff-select:disabled {
      opacity: 0.6;
    }
    .codexhost-handoff-error {
      margin-top: 8px;
      padding: 6px 9px;
      border-radius: 8px;
      background: light-dark(rgba(180, 35, 24, 0.08), rgba(248, 113, 113, 0.13));
      color: light-dark(#b42318, #fca5a5);
      font-size: 12px;
      line-height: 1.4;
      word-break: break-word;
    }
    .codexhost-handoff-popover-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .codexhost-handoff-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
      background: transparent;
      color: light-dark(#18181b, #ececec);
      font: 500 12.5px/1 inherit;
      cursor: pointer;
    }
    .codexhost-handoff-btn:hover:not(:disabled) {
      background: light-dark(rgba(15, 23, 42, 0.05), rgba(255, 255, 255, 0.08));
    }
    .codexhost-handoff-btn--primary {
      border-color: transparent;
      background: light-dark(#18181b, #ececec);
      color: light-dark(#ffffff, #18181b);
    }
    .codexhost-handoff-btn--primary:hover:not(:disabled) {
      opacity: 0.9;
      background: light-dark(#18181b, #ececec);
    }
    .codexhost-handoff-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

export function createHandoffDividerElement(options: HandoffDividerRenderOptions): HTMLElement {
  const { ownerDocument, handoff, plugins = [], locale, onOpenSourceThread } = options;
  ensureRendererHandoffStyle(ownerDocument);
  const messages = rendererHarnessMessages(locale);
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const sourcePlugin = pluginById.get(handoff.sourceHarnessId);
  const targetPlugin = pluginById.get(handoff.targetHarnessId);

  const root = ownerDocument.createElement("section");
  root.setAttribute(HANDOFF_DIVIDER_ATTRIBUTE, handoff.sourceThreadId);
  root.setAttribute("aria-label", messages.handoffTitle);

  const row = ownerDocument.createElement("div");
  row.className = "codexhost-handoff-divider-row";

  const leftLine = ownerDocument.createElement("span");
  leftLine.className = "codexhost-handoff-divider-line";
  leftLine.setAttribute("aria-hidden", "true");

  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = "codexhost-handoff-divider-button";
  button.setAttribute("data-codexhost-handoff-divider-toggle", "true");
  button.setAttribute("aria-expanded", String(Boolean(options.initiallyExpanded)));

  const title = ownerDocument.createElement("span");
  title.className = "codexhost-handoff-divider-title";
  title.textContent = messages.handoffTitle;

  const source = ownerDocument.createElement("span");
  source.className = "codexhost-handoff-endpoint codexhost-handoff-endpoint--source";
  const sourceText = ownerDocument.createElement("span");
  sourceText.className = "codexhost-handoff-endpoint-text";
  sourceText.textContent = formatEndpointLabel(
    handoff.sourceHarnessId,
    handoff.sourceHarnessLabel,
    handoff.sourceModel,
    sourcePlugin,
  );
  source.append(
    createRendererAgentIcon(handoff.sourceHarnessId, 15, ownerDocument, sourcePlugin),
    sourceText,
  );

  const arrow = ownerDocument.createElement("span");
  arrow.className = "codexhost-handoff-divider-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";

  const target = ownerDocument.createElement("span");
  target.className = "codexhost-handoff-endpoint codexhost-handoff-endpoint--target";
  const targetText = ownerDocument.createElement("span");
  targetText.className = "codexhost-handoff-endpoint-text";
  targetText.textContent = formatEndpointLabel(
    handoff.targetHarnessId,
    handoff.targetHarnessLabel,
    handoff.targetModel,
    targetPlugin,
  );
  target.append(
    createRendererAgentIcon(handoff.targetHarnessId, 15, ownerDocument, targetPlugin),
    targetText,
  );

  button.append(
    createSwapIcon(ownerDocument, 14),
    title,
    source,
    arrow,
    target,
    createChevronIcon(ownerDocument),
  );

  const rightLine = ownerDocument.createElement("span");
  rightLine.className = "codexhost-handoff-divider-line";
  rightLine.setAttribute("aria-hidden", "true");

  row.append(leftLine, button, rightLine);

  const detail = ownerDocument.createElement("div");
  detail.className = "codexhost-handoff-detail";
  detail.setAttribute("data-codexhost-handoff-detail", "true");
  detail.hidden = !options.initiallyExpanded;

  const detailHeader = ownerDocument.createElement("div");
  detailHeader.className = "codexhost-handoff-detail-header";

  const turnsSummary = ownerDocument.createElement("span");
  turnsSummary.className = "codexhost-handoff-turns-summary";
  turnsSummary.textContent = formatRendererHandoffTurnsSummary(locale, {
    includedCount: handoff.includedTurnNumbers.length,
    totalTurns: handoff.totalTurns,
    omittedTurns: handoff.omittedTurns,
    boundaryTurnNumber: handoff.boundaryTurnNumber,
  });

  const sourceBtn = ownerDocument.createElement("button");
  sourceBtn.type = "button";
  sourceBtn.className = "codexhost-handoff-source-btn";
  sourceBtn.setAttribute("data-codexhost-handoff-open-source", "true");
  sourceBtn.textContent = `${messages.handoffOpenSourceThread} ↗`;
  sourceBtn.addEventListener("click", () => {
    onOpenSourceThread(handoff.sourceThreadId);
  });

  detailHeader.append(turnsSummary, sourceBtn);

  const previewLabel = ownerDocument.createElement("div");
  previewLabel.className = "codexhost-handoff-preview-label";
  previewLabel.textContent = messages.handoffPreviewLabel;

  const preview = ownerDocument.createElement("pre");
  preview.className = "codexhost-handoff-preview";
  preview.textContent = handoff.preview;

  detail.append(detailHeader, previewLabel, preview);

  button.addEventListener("click", () => {
    const nextExpanded = detail.hidden;
    detail.hidden = !nextExpanded;
    button.setAttribute("aria-expanded", String(nextExpanded));
  });

  root.append(row, detail);
  return root;
}

export function renderHandoffPopoverContent(
  popover: HTMLElement,
  options: HandoffPopoverViewOptions,
): void {
  const {
    ownerDocument,
    locale,
    harnesses,
    selectedHarnessId,
    catalog,
    loadingModels,
    selectedModelId,
    selectedThinkingOptionId,
    submitting,
    errorMessage,
    onSelectHarness,
    onSelectModel,
    onSelectThinking,
    onConfirm,
    onCancel,
  } = options;
  ensureRendererHandoffStyle(ownerDocument);
  const messages = rendererHarnessMessages(locale);

  popover.replaceChildren();
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", messages.handoffTitle);

  const header = ownerDocument.createElement("div");
  header.className = "codexhost-handoff-popover-header";

  const title = ownerDocument.createElement("div");
  title.className = "codexhost-handoff-popover-title";
  const titleText = ownerDocument.createElement("span");
  titleText.textContent = messages.handoffTitle;
  title.append(createSwapIcon(ownerDocument, 14), titleText);

  const closeButton = ownerDocument.createElement("button");
  closeButton.type = "button";
  closeButton.className = "codexhost-handoff-popover-close";
  closeButton.setAttribute("aria-label", messages.handoffCancel);
  closeButton.textContent = "×";
  closeButton.disabled = Boolean(submitting);
  closeButton.addEventListener("click", onCancel);

  header.append(title, closeButton);
  popover.append(header);

  const harnessLabel = ownerDocument.createElement("div");
  harnessLabel.className = "codexhost-handoff-field-label";
  harnessLabel.textContent = messages.handoffTargetHarnessLabel;
  popover.append(harnessLabel);

  const list = ownerDocument.createElement("div");
  list.className = "codexhost-handoff-harness-list";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", messages.handoffTargetHarnessLabel);

  for (const item of harnesses) {
    const selected = item.id === selectedHarnessId;
    const option = ownerDocument.createElement("button");
    option.type = "button";
    option.className = "codexhost-handoff-harness-option";
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(selected));
    option.dataset.harnessId = item.id;
    option.disabled = Boolean(submitting);

    const name = ownerDocument.createElement("span");
    name.className = "codexhost-handoff-harness-name";
    name.textContent = item.label;

    option.append(createRendererAgentIcon(item.id, 18, ownerDocument, item.plugin), name);
    if (selected) {
      const check = ownerDocument.createElement("span");
      check.className = "codexhost-handoff-harness-check";
      check.append(createCheckIcon(ownerDocument));
      option.append(check);
    }
    option.addEventListener("click", () => onSelectHarness(item.id));
    list.append(option);
  }
  popover.append(list);

  const models = catalog?.models ?? [];
  if (loadingModels || models.length > 0) {
    const modelLabel = ownerDocument.createElement("label");
    modelLabel.className = "codexhost-handoff-field-label";
    modelLabel.textContent = messages.handoffTargetModelLabel;

    const modelSelect = ownerDocument.createElement("select");
    modelSelect.className = "codexhost-handoff-select";
    modelSelect.setAttribute("data-codexhost-handoff-model-select", "true");
    modelSelect.disabled = Boolean(submitting || loadingModels);

    const defaultOpt = ownerDocument.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = loadingModels
      ? messages.handoffLoadingModels
      : messages.handoffDefaultModelOption;
    modelSelect.append(defaultOpt);

    for (const model of models) {
      const key = harnessModelRefKey(model.ref);
      const opt = ownerDocument.createElement("option");
      opt.value = key;
      opt.textContent = model.label;
      if (key === selectedModelId) opt.selected = true;
      modelSelect.append(opt);
    }
    modelSelect.value = selectedModelId;
    modelSelect.addEventListener("change", () => onSelectModel(modelSelect.value));

    popover.append(modelLabel, modelSelect);
  }

  let selectedModel: HarnessModelCatalog["models"][number] | undefined;
  if (selectedModelId) {
    try {
      selectedModel = catalogModelForRef(catalog, harnessModelRefFromKey(selectedModelId));
    } catch {
      selectedModel = undefined;
    }
  }
  const availableThinking =
    catalog && catalog.thinkingOptions.length > 0
      ? selectedModel?.supportedThinkingOptionIds
        ? catalog.thinkingOptions.filter(({ id }) =>
            selectedModel.supportedThinkingOptionIds?.includes(id),
          )
        : catalog.thinkingOptions
      : [];

  if (!loadingModels && availableThinking.length > 0) {
    const thinkingLabel = ownerDocument.createElement("label");
    thinkingLabel.className = "codexhost-handoff-field-label";
    thinkingLabel.textContent = messages.handoffTargetThinkingLabel;

    const thinkingSelect = ownerDocument.createElement("select");
    thinkingSelect.className = "codexhost-handoff-select";
    thinkingSelect.setAttribute("data-codexhost-handoff-thinking-select", "true");
    thinkingSelect.disabled = Boolean(submitting);

    const defaultOpt = ownerDocument.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = messages.handoffDefaultThinkingOption;
    thinkingSelect.append(defaultOpt);

    for (const option of availableThinking) {
      const opt = ownerDocument.createElement("option");
      opt.value = option.id;
      opt.textContent = option.label;
      if (option.id === selectedThinkingOptionId) opt.selected = true;
      thinkingSelect.append(opt);
    }
    thinkingSelect.value = selectedThinkingOptionId;
    thinkingSelect.addEventListener("change", () => onSelectThinking(thinkingSelect.value));

    popover.append(thinkingLabel, thinkingSelect);
  }

  if (errorMessage) {
    const error = ownerDocument.createElement("div");
    error.className = "codexhost-handoff-error";
    error.setAttribute("role", "alert");
    error.textContent = errorMessage;
    popover.append(error);
  }

  const actions = ownerDocument.createElement("div");
  actions.className = "codexhost-handoff-popover-actions";

  const cancelBtn = ownerDocument.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "codexhost-handoff-btn";
  cancelBtn.textContent = messages.handoffCancel;
  cancelBtn.disabled = Boolean(submitting);
  cancelBtn.addEventListener("click", onCancel);

  const confirmBtn = ownerDocument.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "codexhost-handoff-btn codexhost-handoff-btn--primary";
  confirmBtn.setAttribute("data-codexhost-handoff-confirm", "true");
  confirmBtn.textContent = submitting ? messages.handoffSubmitting : messages.handoffConfirm;
  confirmBtn.disabled = Boolean(submitting || !selectedHarnessId);
  confirmBtn.addEventListener("click", onConfirm);

  actions.append(cancelBtn, confirmBtn);
  popover.append(actions);
}
