import {
  catalogModelForRef,
  harnessIdSchema,
  harnessModelRefFromKey,
  harnessModelRefKey,
  sameHarnessModelRef,
  harnessThinkingOptionIdSchema,
  type HarnessDelegationDefault,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPluginDescriptor,
  type HarnessSessionCapabilities,
} from "@codexhost/shared-contracts";
import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
} from "../agent-group-preference.js";
import { createRendererAgentIcon, rendererAgentLabel } from "../renderer-agent-icon.js";
import type { RendererModelClient } from "../renderer-model-client.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "./connections-page.js";
import { reconcileElementChildren } from "./connection-row.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  createDelegationDiagram,
  delegationAgentDotColor,
  type DelegationDiagramAgent,
} from "./delegation-diagram.js";
import type { DelegationMessages } from "./delegation-messages.js";
import type { RendererSettingsMessages } from "./localization.js";

export type RendererDelegationClient = Pick<
  RendererModelClient,
  | "getHarnessPreferences"
  | "patchHarnessPreferences"
  | "subscribeHarnessPreferences"
  | "inspectHarness"
>;

interface DelegationReadyAgent {
  readonly id: string;
  readonly name: string;
  readonly plugin?: HarnessPluginDescriptor | undefined;
}

type CatalogCacheEntry =
  | { readonly status: "loading"; readonly promise: Promise<void> }
  | {
      readonly status: "ready";
      readonly catalog: HarnessModelCatalog;
      readonly capabilities: HarnessSessionCapabilities;
    }
  | { readonly status: "error"; readonly message: string };

interface DelegationRowView {
  readonly root: HTMLElement;
  readonly modelSelect: HTMLSelectElement;
  readonly effortWrap: HTMLElement;
  readonly effortSelect: HTMLSelectElement;
  readonly feedback: HTMLElement;
  readonly effectiveCell: HTMLElement;
  readonly markWrap: HTMLElement;
  readonly dotEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly idEl: HTMLElement;
  iconSignature: string;
}

interface HowtoExample {
  readonly tag: string;
  readonly text: string;
  readonly full: string;
}

function toggleClass(el: Element, className: string, force: boolean): void {
  if (el.classList && typeof el.classList.toggle === "function") {
    el.classList.toggle(className, force);
    return;
  }
  const current = new Set(
    (el.getAttribute("class") ?? el.className ?? "").toString().split(/\s+/u).filter(Boolean),
  );
  if (force) current.add(className);
  else current.delete(className);
  const next = [...current].join(" ");
  if (typeof el.setAttribute === "function") el.setAttribute("class", next);
}

function formatTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => values[key] ?? "");
}

function resolveReadyAgents(
  snapshot: RendererConnectionSnapshot | null,
  groupPreference: AgentGroupPreferenceStore,
): DelegationReadyAgent[] {
  const localHost =
    snapshot?.hosts.find((host) => host.hostId === "local") ?? snapshot?.hosts[0] ?? null;
  const readyExternal = (localHost?.agents ?? []).filter(
    (agent) => agent.availability === "ready" || agent.error?.code === "credentialAccessRequired",
  );
  const externalById = new Map(readyExternal.map((agent) => [agent.agent, agent]));
  const catalog = readyExternal.map((agent) => ({
    id: agent.agent,
    name: rendererAgentLabel(agent.agent, agent.plugin),
  }));

  const orderedExternal: DelegationReadyAgent[] = [];
  const seen = new Set<string>();
  for (const entry of groupPreference.list(undefined, catalog)) {
    const snap = externalById.get(entry.agent);
    if (!snap || seen.has(snap.agent)) continue;
    seen.add(snap.agent);
    orderedExternal.push({
      id: snap.agent,
      name: rendererAgentLabel(snap.agent, snap.plugin),
      plugin: snap.plugin,
    });
  }
  for (const snap of readyExternal) {
    if (seen.has(snap.agent)) continue;
    seen.add(snap.agent);
    orderedExternal.push({
      id: snap.agent,
      name: rendererAgentLabel(snap.agent, snap.plugin),
      plugin: snap.plugin,
    });
  }

  return [{ id: "codex", name: rendererAgentLabel("codex") }, ...orderedExternal];
}

function supportedThinkingOptions(
  entry: CatalogCacheEntry | undefined,
  selectedModelId: string | undefined,
): readonly { id: string; label: string }[] | null {
  if (!entry || entry.status !== "ready") return null;
  if (!entry.capabilities.configuration.selectThinkingOption) return [];
  const ref = selectedModelId
    ? harnessModelRefFromKey(selectedModelId)
    : entry.catalog.defaultModel;
  const model = catalogModelForRef(entry.catalog, ref);
  const supportedIds = model?.supportedThinkingOptionIds ?? [];
  if (supportedIds.length === 0) return [];
  const labelById = new Map(
    entry.catalog.thinkingOptions.map((option) => [option.id, option.label]),
  );
  return supportedIds.map((id) => ({ id, label: labelById.get(id) ?? id }));
}

function resolveModelLabel(
  harnessId: string,
  entry: CatalogCacheEntry | undefined,
  ref: HarnessModelRef,
): string {
  const found = catalogModelForRef(entry?.status === "ready" ? entry.catalog : undefined, ref);
  if (harnessId !== "codex") return found?.label ?? ref.id;
  if (found)
    return sameHarnessModelRef(found.fastModel, ref) ? `${found.label} · Fast` : found.label;
  const { id, serviceTier } = ref;
  return (
    id +
    (serviceTier === "priority" ? " · Fast" : serviceTier === "ultrafast" ? " · Ultrafast" : "")
  );
}

function resolveThinkingLabel(
  entry: CatalogCacheEntry | undefined,
  thinkingId: string | undefined,
): string | null {
  if (!thinkingId) return null;
  if (entry?.status === "ready") {
    const found = entry.catalog.thinkingOptions.find((option) => option.id === thinkingId);
    if (found) return found.label;
  }
  return thinkingId;
}

function formatEffectiveSummary(
  harnessId: string,
  saved: HarnessDelegationDefault | undefined,
  entry: CatalogCacheEntry | undefined,
  copy: DelegationMessages,
  compactDefault: boolean,
): { text: string; overridden: boolean } {
  const modelLabel = saved?.model ? resolveModelLabel(harnessId, entry, saved.model) : null;
  const thinkingLabel = resolveThinkingLabel(entry, saved?.thinkingOptionId);
  if (!modelLabel && !thinkingLabel) {
    return {
      text: compactDefault ? copy.laneDefaultModel : copy.followAgentDefault,
      overridden: false,
    };
  }
  if (modelLabel && thinkingLabel) {
    return { text: `${modelLabel} · ${thinkingLabel}`, overridden: true };
  }
  if (modelLabel) {
    return { text: modelLabel, overridden: true };
  }
  return {
    text: `${compactDefault ? copy.laneDefaultModel : copy.followAgentDefault} · ${thinkingLabel}`,
    overridden: true,
  };
}

function buildHowtoExamples(
  agents: readonly DelegationReadyAgent[],
  copy: DelegationMessages,
): readonly HowtoExample[] {
  const externalIds = agents.filter((agent) => agent.id !== "codex").map((agent) => agent.id);
  const second = externalIds.includes("claude-code")
    ? "claude-code"
    : (externalIds[0] ?? "claude-code");
  const third = externalIds.includes("grok")
    ? "grok"
    : (externalIds.find((id) => id !== second) ?? "grok");
  const ids = ["codex", second, third] as const;
  return ids.map((id, index) => {
    const tag = `#${id}`;
    const text = copy.exampleTasks[index] ?? copy.exampleTasks[0];
    return { tag, text, full: `${tag} ${text}` };
  });
}

function setSelectOptions(
  doc: Document,
  select: HTMLSelectElement,
  options: readonly { value: string; label: string; disabled?: boolean }[],
  selectedValue: string,
): void {
  const nodes = options.map((opt) => {
    const option = doc.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.disabled) option.disabled = true;
    return option;
  });
  select.replaceChildren(...nodes);
  select.value = selectedValue;
}

export function createDelegationSettingsPage(
  messages: RendererSettingsMessages,
  getDiagnostics: () => RendererConnectionDiagnostics | null = () => null,
  getClient: () => RendererDelegationClient | null = () => null,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
): RendererSettingsPageDefinition {
  const copy = messages.delegation;

  return Object.freeze({
    id: "delegation",
    label: messages.pageLabels.delegation,
    icon: "delegation",
    mount(context: RendererSettingsPageMountContext) {
      const doc = context.content.ownerDocument;
      const ownerWindow = doc.defaultView;

      const root = doc.createElement("div");
      root.className = "settings-delegation";

      // 1. Header
      const header = doc.createElement("header");
      header.className = "settings-delegation__head";
      const heading = doc.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = copy.title;
      const description = doc.createElement("p");
      description.className = "settings-page-description";
      description.textContent = copy.description;
      header.append(heading, description);

      // State
      const diagnostics = getDiagnostics();
      let readyAgents = resolveReadyAgents(diagnostics?.snapshot() ?? null, groupPreference);
      let confirmedByHarness: Record<string, HarnessDelegationDefault> = {};
      let delegationByHarness: Record<string, HarnessDelegationDefault> = {};
      const catalogs = new Map<string, CatalogCacheEntry>();
      const patchSeqByHarness = new Map<string, number>();
      const inFlightPatchCount = new Map<string, number>();
      const saveErrorByHarness = new Map<string, string>();
      const rowViews = new Map<string, DelegationRowView>();
      let disposed = false;
      let preferencesLoadGeneration = 0;

      const isActive = (): boolean => !disposed && !context.signal.aborted;

      const diagramAgents = (): DelegationDiagramAgent[] =>
        readyAgents.map((agent) => {
          const summary = formatEffectiveSummary(
            agent.id,
            delegationByHarness[agent.id],
            catalogs.get(agent.id),
            copy,
            true,
          );
          return {
            id: agent.id,
            name: agent.name,
            plugin: agent.plugin,
            modelText: summary.text,
            overridden: summary.overridden,
          };
        });

      // 2. Hero Diagram
      const diagram = createDelegationDiagram(doc, copy, diagramAgents());

      // 3. One-line # Quick-start Strip
      let examples = buildHowtoExamples(readyAgents, copy);
      let exampleIndex = 0;
      let copyTimer: number | null = null;

      const howto = doc.createElement("section");
      howto.className = "settings-delegation__howto";
      howto.setAttribute("aria-label", copy.howtoAriaLabel);
      const howtoMain = doc.createElement("div");
      howtoMain.className = "settings-delegation__howto-main";
      const howtoPrefix = doc.createElement("span");
      howtoPrefix.textContent = copy.howtoPrefix;
      const kbd = doc.createElement("kbd");
      kbd.className = "settings-delegation__kbd";
      kbd.textContent = "#";
      const howtoSuffix = doc.createElement("span");
      howtoSuffix.textContent = copy.howtoSuffix;

      const demoTrigger = doc.createElement("button");
      demoTrigger.type = "button";
      demoTrigger.className = "settings-delegation__demo-trigger";
      demoTrigger.title = copy.howtoCopyTitle;
      const demoHash = doc.createElement("span");
      demoHash.className = "settings-delegation__demo-hash";
      const demoText = doc.createElement("span");
      demoText.className = "settings-delegation__demo-text";
      const demoCaret = doc.createElement("span");
      demoCaret.className = "settings-delegation__demo-caret";
      demoCaret.setAttribute("aria-hidden", "true");
      const copyHint = doc.createElement("span");
      copyHint.className = "settings-delegation__copy-hint";
      copyHint.textContent = copy.howtoCopy;
      demoTrigger.append(demoHash, demoText, demoCaret, copyHint);

      const syncExampleDisplay = (): void => {
        const current = examples[exampleIndex % examples.length] ?? examples[0];
        if (!current) return;
        demoHash.textContent = current.tag;
        demoText.textContent = current.text;
      };
      syncExampleDisplay();

      const onDemoClick = (): void => {
        const current = examples[exampleIndex % examples.length] ?? examples[0];
        if (!current) return;
        const finishCopy = (succeeded: boolean): void => {
          if (!isActive()) return;
          toggleClass(demoTrigger, "is-copied", succeeded);
          copyHint.textContent = succeeded ? copy.howtoCopied : copy.howtoCopyFailed;
          if (copyTimer !== null) ownerWindow?.clearTimeout?.(copyTimer);
          if (ownerWindow?.setTimeout) {
            copyTimer = ownerWindow.setTimeout(() => {
              copyTimer = null;
              if (!isActive()) return;
              toggleClass(demoTrigger, "is-copied", false);
              copyHint.textContent = copy.howtoCopy;
              if (succeeded) {
                exampleIndex = (exampleIndex + 1) % examples.length;
                syncExampleDisplay();
              }
            }, 1_150);
          }
        };
        const clipboard = ownerWindow?.navigator?.clipboard;
        if (!clipboard?.writeText) {
          finishCopy(false);
          return;
        }
        void clipboard.writeText(current.full).then(
          () => finishCopy(true),
          () => finishCopy(false),
        );
      };
      demoTrigger.addEventListener("click", onDemoClick);

      howtoMain.append(howtoPrefix, kbd, howtoSuffix, demoTrigger);
      const howtoAlt = doc.createElement("span");
      howtoAlt.className = "settings-delegation__howto-alt";
      howtoAlt.textContent = copy.howtoAlt;
      howto.append(howtoMain, howtoAlt);

      // 4. Default Models Section
      const modelsSection = doc.createElement("section");
      const modelsHeadingId = "codexhost-delegation-models-title";
      modelsSection.setAttribute("aria-labelledby", modelsHeadingId);

      const sectionHead = doc.createElement("div");
      sectionHead.className = "settings-delegation__section-head";
      const sectionTitle = doc.createElement("h2");
      sectionTitle.id = modelsHeadingId;
      sectionTitle.textContent = copy.modelsTitle;

      const priority = doc.createElement("div");
      priority.className = "settings-delegation__prio";
      priority.append(copy.priorityPrefix);
      copy.prioritySteps.forEach((step, idx) => {
        if (idx > 0) priority.append(" › ");
        const strong = doc.createElement("strong");
        strong.textContent = step;
        priority.append(strong);
      });
      sectionHead.append(sectionTitle, priority);

      const unavailableNotice = doc.createElement("div");
      unavailableNotice.className = "settings-delegation__notice";
      unavailableNotice.setAttribute("role", "status");
      unavailableNotice.textContent = copy.unavailable;
      unavailableNotice.hidden = true;

      const group = doc.createElement("div");
      group.className = "settings-delegation__group";

      const footnote = doc.createElement("div");
      footnote.className = "settings-delegation__footnote";
      footnote.textContent = copy.footnote;

      modelsSection.append(sectionHead, unavailableNotice, group, footnote);
      root.append(header, diagram.element, howto, modelsSection);
      context.content.append(root);

      const canPersist = (): boolean => {
        const client = getClient();
        return Boolean(client?.getHarnessPreferences && client?.patchHarnessPreferences);
      };

      const ensureCatalog = (harnessId: string, forceRetry = false): void => {
        const client = getClient();
        if (!client?.inspectHarness) return;
        const existing = catalogs.get(harnessId);
        if (existing?.status === "loading" || existing?.status === "ready") return;
        if (existing?.status === "error" && !forceRetry) return;

        const parsedHarnessId = harnessIdSchema.safeParse(harnessId);
        if (!parsedHarnessId.success) return;

        const promise = Promise.resolve()
          .then(async () => {
            const inspection = await client.inspectHarness({
              harnessId: parsedHarnessId.data,
              credentialAccess: forceRetry ? "retry" : "allow",
            });
            if (!isActive()) return;
            if (inspection.status === "ready") {
              catalogs.set(harnessId, {
                status: "ready",
                catalog: inspection.catalog,
                capabilities: inspection.capabilities,
              });
            } else {
              catalogs.set(harnessId, {
                status: "error",
                message: inspection.error.message || copy.loadFailed,
              });
            }
          })
          .catch((error: unknown) => {
            if (!isActive()) return;
            catalogs.set(harnessId, {
              status: "error",
              message: error instanceof Error && error.message ? error.message : copy.loadFailed,
            });
          })
          .finally(() => {
            if (!isActive()) return;
            syncRow(harnessId);
            diagram.updateAgents(diagramAgents());
          });

        catalogs.set(harnessId, { status: "loading", promise });
        syncRow(harnessId);
      };

      const saveDelegationPreference = (
        harnessId: string,
        configuration: HarnessDelegationDefault | null,
      ): void => {
        const client = getClient();
        if (!client?.patchHarnessPreferences) return;
        const parsedHarnessId = harnessIdSchema.safeParse(harnessId);
        if (!parsedHarnessId.success) return;

        const nextSeq = (patchSeqByHarness.get(harnessId) ?? 0) + 1;
        patchSeqByHarness.set(harnessId, nextSeq);
        inFlightPatchCount.set(harnessId, (inFlightPatchCount.get(harnessId) ?? 0) + 1);
        saveErrorByHarness.delete(harnessId);

        if (configuration) {
          delegationByHarness = { ...delegationByHarness, [harnessId]: configuration };
        } else {
          const next = { ...delegationByHarness };
          Reflect.deleteProperty(next, harnessId);
          delegationByHarness = next;
        }
        syncRow(harnessId);
        diagram.updateAgents(diagramAgents());

        void client
          .patchHarnessPreferences({
            scope: "external",
            operations: [
              {
                kind: "delegation",
                harnessId: parsedHarnessId.data,
                configuration,
              },
            ],
          })
          .then((snapshot) => {
            if (!isActive()) return;
            const latestConfirmed = snapshot.values.delegation?.byHarness ?? {};
            confirmedByHarness = { ...latestConfirmed };
            if (patchSeqByHarness.get(harnessId) === nextSeq) {
              const merged = { ...latestConfirmed };
              for (const [id, count] of inFlightPatchCount) {
                if (id !== harnessId && count > 0) {
                  const local = delegationByHarness[id];
                  if (local) merged[id] = local;
                  else Reflect.deleteProperty(merged, id);
                }
              }
              delegationByHarness = merged;
              saveErrorByHarness.delete(harnessId);
            }
          })
          .catch((error: unknown) => {
            if (!isActive()) return;
            if (patchSeqByHarness.get(harnessId) === nextSeq) {
              const reverted = { ...delegationByHarness };
              const confirmed = confirmedByHarness[harnessId];
              if (confirmed) reverted[harnessId] = confirmed;
              else Reflect.deleteProperty(reverted, harnessId);
              delegationByHarness = reverted;
              saveErrorByHarness.set(
                harnessId,
                error instanceof Error && error.message ? error.message : copy.saveFailed,
              );
            }
          })
          .finally(() => {
            const remaining = Math.max(0, (inFlightPatchCount.get(harnessId) ?? 1) - 1);
            if (remaining === 0) inFlightPatchCount.delete(harnessId);
            else inFlightPatchCount.set(harnessId, remaining);
            if (!isActive()) return;
            syncAllRows();
            diagram.updateAgents(diagramAgents());
          });
      };

      const createRowView = (agent: DelegationReadyAgent): DelegationRowView => {
        const row = doc.createElement("div");
        row.className = "settings-delegation__row";
        row.dataset.harnessId = agent.id;

        const agentCell = doc.createElement("div");
        agentCell.className = "settings-delegation__agent-cell";
        const markWrap = doc.createElement("span");
        markWrap.className = "settings-delegation__agent-mark";
        markWrap.setAttribute("aria-hidden", "true");
        const dotEl = doc.createElement("span");
        dotEl.className = "settings-delegation__dot";
        dotEl.setAttribute("aria-hidden", "true");
        const meta = doc.createElement("div");
        meta.className = "settings-delegation__agent-meta";
        const nameEl = doc.createElement("div");
        nameEl.className = "settings-delegation__agent-name";
        const idEl = doc.createElement("div");
        idEl.className = "settings-delegation__agent-id";
        meta.append(nameEl, idEl);
        agentCell.append(markWrap, dotEl, meta);

        const controlsCell = doc.createElement("div");
        controlsCell.className = "settings-delegation__controls-cell";
        const selects = doc.createElement("div");
        selects.className = "settings-delegation__selects";

        const modelWrap = doc.createElement("div");
        modelWrap.className =
          "settings-delegation__select-wrap settings-delegation__select-wrap--model";
        const modelSelect = doc.createElement("select");
        modelSelect.className = "settings-delegation__select";
        modelSelect.dataset.delegationControl = "model";
        modelWrap.append(modelSelect);

        const effortWrap = doc.createElement("div");
        effortWrap.className =
          "settings-delegation__select-wrap settings-delegation__select-wrap--effort";
        const effortSelect = doc.createElement("select");
        effortSelect.className = "settings-delegation__select";
        effortSelect.dataset.delegationControl = "thinking";
        effortWrap.append(effortSelect);

        selects.append(modelWrap, effortWrap);

        const feedback = doc.createElement("div");
        feedback.className = "settings-delegation__row-feedback";
        feedback.setAttribute("role", "status");
        feedback.hidden = true;
        controlsCell.append(selects, feedback);

        const effectiveCell = doc.createElement("div");
        effectiveCell.className = "settings-delegation__effective-cell";

        row.append(agentCell, controlsCell, effectiveCell);

        const triggerLoad = (): void => ensureCatalog(agent.id);
        modelSelect.addEventListener("focus", triggerLoad);
        modelSelect.addEventListener("pointerdown", triggerLoad);
        modelSelect.addEventListener("mousedown", triggerLoad);
        effortSelect.addEventListener("focus", triggerLoad);
        effortSelect.addEventListener("pointerdown", triggerLoad);
        effortSelect.addEventListener("mousedown", triggerLoad);

        modelSelect.addEventListener("change", () => {
          const nextModelId = modelSelect.value;
          const saved = delegationByHarness[agent.id];
          let nextThinkingId = saved?.thinkingOptionId;
          const entry = catalogs.get(agent.id);
          if (entry?.status === "ready" && nextThinkingId) {
            const supported = supportedThinkingOptions(entry, nextModelId || undefined) ?? [];
            if (!supported.some((option) => option.id === nextThinkingId)) {
              nextThinkingId = undefined;
            }
          }
          const nextConfig: HarnessDelegationDefault | null =
            nextModelId || nextThinkingId
              ? {
                  ...(nextModelId ? { model: harnessModelRefFromKey(nextModelId) } : {}),
                  ...(nextThinkingId
                    ? { thinkingOptionId: harnessThinkingOptionIdSchema.parse(nextThinkingId) }
                    : {}),
                }
              : null;
          saveDelegationPreference(agent.id, nextConfig);
        });

        effortSelect.addEventListener("change", () => {
          const nextThinkingId = effortSelect.value;
          const saved = delegationByHarness[agent.id];
          const nextModel = saved?.model;
          const nextConfig: HarnessDelegationDefault | null =
            nextModel || nextThinkingId
              ? {
                  ...(nextModel ? { model: nextModel } : {}),
                  ...(nextThinkingId
                    ? { thinkingOptionId: harnessThinkingOptionIdSchema.parse(nextThinkingId) }
                    : {}),
                }
              : null;
          saveDelegationPreference(agent.id, nextConfig);
        });

        return {
          root: row,
          modelSelect,
          effortWrap,
          effortSelect,
          feedback,
          effectiveCell,
          markWrap,
          dotEl,
          nameEl,
          idEl,
          iconSignature: "",
        };
      };

      const syncRow = (harnessId: string): void => {
        const agent = readyAgents.find((candidate) => candidate.id === harnessId);
        const view = rowViews.get(harnessId);
        if (!agent || !view) return;

        const saved = delegationByHarness[harnessId];
        const entry = catalogs.get(harnessId);
        const persistable = canPersist();

        view.dotEl.style.background = delegationAgentDotColor(agent.id);
        view.nameEl.textContent = agent.name;
        view.idEl.textContent = agent.id;
        view.modelSelect.setAttribute(
          "aria-label",
          formatTemplate(copy.modelSelectLabel, { agent: agent.name }),
        );
        view.effortSelect.setAttribute(
          "aria-label",
          formatTemplate(copy.thinkingSelectLabel, { agent: agent.name }),
        );

        const iconSig = `${agent.id}:${agent.plugin ? "1" : "0"}:${agent.plugin?.icon ?? ""}:${agent.plugin?.iconStyle ? JSON.stringify(agent.plugin.iconStyle) : ""}`;
        if (view.iconSignature !== iconSig) {
          view.iconSignature = iconSig;
          view.markWrap.replaceChildren(createRendererAgentIcon(agent.id, 18, doc, agent.plugin));
        }

        // Model options
        const savedModel = saved?.model;
        const savedModelId = savedModel ? harnessModelRefKey(savedModel) : "";
        const modelOptions: Array<{ value: string; label: string; disabled?: boolean }> = [
          { value: "", label: copy.followAgentDefault },
        ];
        if (entry?.status === "ready") {
          for (const model of entry.catalog.models) {
            modelOptions.push({ value: harnessModelRefKey(model.ref), label: model.label });
          }
        }
        if (savedModel && !modelOptions.some(({ value }) => value === savedModelId)) {
          modelOptions.push({
            value: savedModelId,
            label: resolveModelLabel(harnessId, entry, savedModel),
          });
        }
        if (entry?.status === "loading") {
          modelOptions.push({ value: "__loading__", label: copy.loadingModels, disabled: true });
        }
        setSelectOptions(doc, view.modelSelect, modelOptions, savedModelId);
        view.modelSelect.disabled = !persistable;

        // Thinking options
        const savedThinkingId = saved?.thinkingOptionId ?? "";
        const thinkingChoices = supportedThinkingOptions(entry, savedModelId || undefined);
        if (thinkingChoices === null) {
          // Catalog not loaded yet: keep thinking select visible so user can focus/click it to trigger on-demand load.
          view.effortWrap.hidden = false;
          const options: Array<{ value: string; label: string; disabled?: boolean }> = [
            { value: "", label: copy.defaultThinking },
          ];
          if (savedThinkingId) {
            options.push({ value: savedThinkingId, label: savedThinkingId });
          }
          if (entry?.status === "loading") {
            options.push({ value: "__loading__", label: copy.loadingModels, disabled: true });
          }
          setSelectOptions(doc, view.effortSelect, options, savedThinkingId);
          view.effortSelect.disabled = !persistable;
        } else if (thinkingChoices.length === 0) {
          view.effortWrap.hidden = true;
        } else {
          view.effortWrap.hidden = false;
          const options: Array<{ value: string; label: string }> = [
            { value: "", label: copy.defaultThinking },
            ...thinkingChoices.map((option) => ({ value: option.id, label: option.label })),
          ];
          const hasSavedThinking =
            Boolean(savedThinkingId) &&
            thinkingChoices.some((option) => option.id === savedThinkingId);
          setSelectOptions(
            doc,
            view.effortSelect,
            options,
            hasSavedThinking ? savedThinkingId : "",
          );
          view.effortSelect.disabled = !persistable;
        }

        // Inline loading / error feedback
        const saveError = saveErrorByHarness.get(harnessId);
        if (entry?.status === "loading") {
          view.feedback.hidden = false;
          toggleClass(view.feedback, "is-error", false);
          view.feedback.textContent = copy.loadingModels;
        } else if (entry?.status === "error") {
          view.feedback.hidden = false;
          toggleClass(view.feedback, "is-error", true);
          const retry = doc.createElement("button");
          retry.type = "button";
          retry.className = "settings-delegation__retry-link";
          retry.textContent = copy.retry;
          retry.addEventListener("click", () => ensureCatalog(harnessId, true));
          const text = doc.createElement("span");
          text.textContent = copy.loadFailed;
          view.feedback.replaceChildren(text, retry);
        } else if (saveError) {
          view.feedback.hidden = false;
          toggleClass(view.feedback, "is-error", true);
          view.feedback.textContent = copy.saveFailed;
        } else {
          view.feedback.hidden = true;
          view.feedback.replaceChildren();
        }

        // Effective value + Reset button
        const summary = formatEffectiveSummary(harnessId, saved, entry, copy, false);
        toggleClass(view.root, "is-overridden", summary.overridden);
        const valSpan = doc.createElement("span");
        valSpan.className = "settings-delegation__effective-val";
        if (summary.overridden) {
          const bold = doc.createElement("b");
          bold.textContent = summary.text;
          valSpan.append(copy.effectivePrefix, bold);
        } else {
          valSpan.textContent = summary.text;
        }
        valSpan.title = summary.text;

        const effectiveChildren: HTMLElement[] = [valSpan];
        if (summary.overridden && persistable) {
          const resetBtn = doc.createElement("button");
          resetBtn.type = "button";
          resetBtn.className = "settings-delegation__reset-link";
          resetBtn.dataset.delegationAction = "reset";
          resetBtn.textContent = copy.reset;
          resetBtn.addEventListener("click", () => saveDelegationPreference(harnessId, null));
          effectiveChildren.push(resetBtn);
        }
        view.effectiveCell.replaceChildren(...effectiveChildren);
      };

      const syncAllRows = (): void => {
        unavailableNotice.hidden = canPersist();
        const activeIds = new Set(readyAgents.map((agent) => agent.id));
        for (const [id, view] of rowViews) {
          if (!activeIds.has(id)) {
            view.root.remove();
            rowViews.delete(id);
          }
        }
        const orderedRows: HTMLElement[] = [];
        for (const agent of readyAgents) {
          let view = rowViews.get(agent.id);
          if (!view) {
            view = createRowView(agent);
            rowViews.set(agent.id, view);
          }
          syncRow(agent.id);
          orderedRows.push(view.root);
        }
        reconcileElementChildren(group, orderedRows);
      };

      const refreshAgents = (): void => {
        if (!isActive()) return;
        readyAgents = resolveReadyAgents(diagnostics?.snapshot() ?? null, groupPreference);
        examples = buildHowtoExamples(readyAgents, copy);
        syncExampleDisplay();
        syncAllRows();
        diagram.updateAgents(diagramAgents());
      };

      const refreshPreferences = async (): Promise<void> => {
        const client = getClient();
        if (!client?.getHarnessPreferences) {
          syncAllRows();
          return;
        }
        const generation = ++preferencesLoadGeneration;
        try {
          const snapshot = await client.getHarnessPreferences("external");
          if (!isActive() || generation !== preferencesLoadGeneration) return;
          const remote = snapshot.values.delegation?.byHarness ?? {};
          confirmedByHarness = { ...remote };
          const merged = { ...remote };
          for (const [id, count] of inFlightPatchCount) {
            if (count > 0) {
              const local = delegationByHarness[id];
              if (local) merged[id] = local;
              else Reflect.deleteProperty(merged, id);
            }
          }
          delegationByHarness = merged;
          syncAllRows();
          diagram.updateAgents(diagramAgents());
        } catch {
          if (!isActive() || generation !== preferencesLoadGeneration) return;
          syncAllRows();
        }
      };

      syncAllRows();
      void refreshPreferences();

      const unsubscribeDiagnostics = diagnostics?.subscribe(refreshAgents) ?? null;
      const unsubscribeGroups = groupPreference.subscribe(refreshAgents);
      const unsubscribePreferences =
        getClient()?.subscribeHarnessPreferences?.(() => {
          void refreshPreferences();
        }) ?? null;

      return () => {
        disposed = true;
        if (copyTimer !== null) {
          ownerWindow?.clearTimeout?.(copyTimer);
          copyTimer = null;
        }
        demoTrigger.removeEventListener("click", onDemoClick);
        unsubscribeDiagnostics?.();
        unsubscribeGroups();
        unsubscribePreferences?.();
        diagram.dispose();
      };
    },
  });
}
