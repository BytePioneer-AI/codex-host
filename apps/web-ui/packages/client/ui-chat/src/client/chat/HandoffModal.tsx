import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelCatalog, ModelProviderGroup } from "@deepseek-ai/dsh-api-remotes/client";
import {
  Button,
  IconCheckOutlineRegular,
  Input,
  Modal,
  rankByName,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatHandoffInput, ChatViewSlotProps } from "../contract/slots.ts";
import { HandoffHarnessIcon } from "./handoff-utils.tsx";
import css from "./HandoffModal.module.css";

export interface HandoffModalProps {
  readonly open: boolean;
  readonly atSeq?: number | undefined;
  readonly currentHarnessId?: string | undefined;
  readonly initialHarnessId?: string | undefined;
  readonly loadModelCatalog: () => Promise<ModelCatalog>;
  readonly onSubmit: (input: ChatHandoffInput) => Promise<void>;
  readonly onClose: () => void;
  readonly t: ChatViewSlotProps["t"];
}

function defaultModelIdForGroup(
  catalog: ModelCatalog,
  group: ModelProviderGroup | undefined,
): string | undefined {
  if (group === undefined || group.models.length === 0) return undefined;
  const remembered = catalog.rememberedSelections?.[group.id]?.model;
  if (remembered !== undefined && group.models.some((model) => model.id === remembered)) {
    return remembered;
  }
  if (
    catalog.default?.provider === group.id &&
    group.models.some((model) => model.id === catalog.default?.model)
  ) {
    return catalog.default.model;
  }
  return group.models[0]?.id;
}

function defaultThinkingForSelection(
  catalog: ModelCatalog | null,
  group: ModelProviderGroup | undefined,
  modelId: string | undefined,
): string | undefined {
  if (catalog === null || group === undefined || modelId === undefined) return undefined;
  const model = group.models.find((candidate) => candidate.id === modelId);
  const efforts = model?.reasoning?.efforts;
  if (efforts === undefined || efforts.length === 0) return undefined;
  const remembered = catalog.rememberedSelections?.[group.id];
  if (
    remembered?.model === modelId &&
    remembered.reasoningEffort !== undefined &&
    efforts.some((effort) => effort.id === remembered.reasoningEffort)
  ) {
    return remembered.reasoningEffort;
  }
  if (
    model?.reasoning?.defaultEffort !== undefined &&
    efforts.some((effort) => effort.id === model.reasoning?.defaultEffort)
  ) {
    return model.reasoning.defaultEffort;
  }
  return undefined;
}

function orderedHarnesses(catalog: ModelCatalog | null): readonly ModelProviderGroup[] {
  if (catalog === null) return [];
  const order = catalog.harnessOrder ?? [];
  return [...catalog.groups].sort((left, right) => {
    const leftRank = order.indexOf(left.id);
    const rightRank = order.indexOf(right.id);
    return (leftRank < 0 ? Infinity : leftRank) - (rightRank < 0 ? Infinity : rightRank);
  });
}

function pickInitialHarness(
  groups: readonly ModelProviderGroup[],
  currentHarnessId: string | undefined,
  initialHarnessId: string | undefined,
): ModelProviderGroup | undefined {
  if (groups.length === 0) return undefined;
  if (initialHarnessId !== undefined) {
    const explicit = groups.find((group) => group.id === initialHarnessId);
    if (explicit !== undefined) return explicit;
  }
  return groups.find((group) => group.id !== currentHarnessId) ?? groups[0];
}

/** Modal picker for choosing the target Harness and Model for context handoff. */
export function HandoffModal({
  open,
  atSeq,
  currentHarnessId,
  initialHarnessId,
  loadModelCatalog,
  onSubmit,
  onClose,
  t,
}: HandoffModalProps) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedHarnessId, setSelectedHarnessId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(undefined);
  const [modelQuery, setModelQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadCatalog = useCallback(() => {
    let active = true;
    setCatalogStatus("loading");
    setCatalogError(null);
    void loadModelCatalog().then(
      (value) => {
        if (!active) return;
        const groups = orderedHarnesses(value);
        const initial = pickInitialHarness(groups, currentHarnessId, initialHarnessId);
        setCatalog(value);
        setCatalogStatus("ready");
        setSelectedHarnessId(initial?.id ?? null);
        setSelectedModelId(defaultModelIdForGroup(value, initial));
      },
      (error: unknown) => {
        if (!active) return;
        setCatalogStatus("error");
        setCatalogError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [currentHarnessId, initialHarnessId, loadModelCatalog]);

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setModelQuery("");
    return loadCatalog();
  }, [open, loadCatalog]);

  const harnesses = useMemo(() => orderedHarnesses(catalog), [catalog]);
  const selectedGroup = useMemo(
    () => harnesses.find((group) => group.id === selectedHarnessId),
    [harnesses, selectedHarnessId],
  );
  const defaultModelId = useMemo(
    () => (catalog === null ? undefined : defaultModelIdForGroup(catalog, selectedGroup)),
    [catalog, selectedGroup],
  );
  const showSearch = (selectedGroup?.models.length ?? 0) > 6;
  const visibleModels = useMemo(() => {
    const models = selectedGroup?.models ?? [];
    if (!showSearch || modelQuery.trim() === "") return models;
    return rankByName(models, modelQuery.trim());
  }, [modelQuery, selectedGroup?.models, showSearch]);

  const selectHarness = (group: ModelProviderGroup) => {
    if (submitting) return;
    setSelectedHarnessId(group.id);
    setSelectedModelId(
      catalog === null ? group.models[0]?.id : defaultModelIdForGroup(catalog, group),
    );
    setModelQuery("");
    setSubmitError(null);
  };

  const handleConfirm = () => {
    if (submitting || selectedHarnessId === null) return;
    const thinkingOptionId = defaultThinkingForSelection(catalog, selectedGroup, selectedModelId);
    const normalizedTargetModel =
      selectedModelId === undefined || selectedModelId === "harness" ? undefined : selectedModelId;
    setSubmitting(true);
    setSubmitError(null);
    void onSubmit({
      ...(atSeq === undefined ? {} : { atSeq }),
      targetHarnessId: selectedHarnessId,
      ...(normalizedTargetModel === undefined ? {} : { targetModel: normalizedTargetModel }),
      ...(thinkingOptionId === undefined ? {} : { targetThinkingOptionId: thinkingOptionId }),
    }).then(
      () => {
        setSubmitting(false);
        onClose();
      },
      (error: unknown) => {
        setSubmitting(false);
        setSubmitError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const canConfirm = !submitting && catalogStatus === "ready" && selectedHarnessId !== null;

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      closeLabel={t("close")}
      title={t("handoff.modal.title")}
      description={t("handoff.modal.description")}
      className={css.dialog}
      footer={
        <>
          <Button
            variant="outline"
            className={css.modalAction}
            disabled={submitting}
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            className={css.modalAction}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {submitting ? (
              <span className={css.submittingContent}>
                <StateDot state="ongoing" />
                <span>{t("handoff.modal.submitting")}</span>
              </span>
            ) : (
              t("handoff.modal.confirm")
            )}
          </Button>
        </>
      }
    >
      <div className={css.sections} data-handoff-modal="">
        {catalogStatus === "loading" && catalog === null && (
          <div className={css.status} role="status">
            <StateDot state="ongoing" />
            <span>{t("handoff.modal.loadingCatalog")}</span>
          </div>
        )}

        {catalogStatus === "error" && catalogError !== null && (
          <div className={css.errorBox} role="alert">
            <span className={css.errorText}>
              {t("handoff.modal.catalogError", { message: catalogError })}
            </span>
            <Button variant="outline" size="sm" onClick={() => void loadCatalog()}>
              {t("retry")}
            </Button>
          </div>
        )}

        {catalog !== null && harnesses.length === 0 && (
          <div className={css.empty}>{t("handoff.modal.noHarnesses")}</div>
        )}

        {harnesses.length > 0 && (
          <>
            <div className={css.section}>
              <span className={css.sectionLabel}>{t("handoff.modal.targetHarness")}</span>
              <div
                className={css.harnessGrid}
                role="radiogroup"
                aria-label={t("handoff.modal.targetHarness")}
              >
                {harnesses.map((group) => {
                  const selected = group.id === selectedHarnessId;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-selected={selected || undefined}
                      disabled={submitting}
                      className={css.harnessOption}
                      onClick={() => selectHarness(group)}
                    >
                      <HandoffHarnessIcon harnessId={group.id} label={group.name} size={16} />
                      <span className={css.harnessName}>{group.name}</span>
                      {selected && <IconCheckOutlineRegular size={14} className={css.checkIcon} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedGroup !== undefined && (
              <div className={css.section}>
                <span className={css.sectionLabel}>{t("handoff.modal.targetModel")}</span>
                {showSearch && (
                  <Input
                    className={css.searchInput}
                    type="text"
                    role="searchbox"
                    placeholder={t("handoff.modal.searchModels")}
                    aria-label={t("handoff.modal.searchModels")}
                    value={modelQuery}
                    disabled={submitting}
                    onChange={(event) => {
                      setModelQuery(event.target.value);
                    }}
                  />
                )}
                {selectedGroup.models.length === 0 ? (
                  <div className={css.empty}>{t("handoff.modal.noModels")}</div>
                ) : (
                  <div
                    className={css.modelList}
                    role="radiogroup"
                    aria-label={t("handoff.modal.targetModel")}
                  >
                    {visibleModels.length === 0 ? (
                      <div className={css.empty}>{t("handoff.modal.noMatchingModels")}</div>
                    ) : (
                      visibleModels.map((model) => {
                        const selected = model.id === selectedModelId;
                        const isDefault = model.id === defaultModelId;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-selected={selected || undefined}
                            disabled={submitting}
                            className={css.modelOption}
                            onClick={() => {
                              setSelectedModelId(model.id);
                              setSubmitError(null);
                            }}
                          >
                            <span className={css.modelInfo}>
                              <span className={css.modelTitleRow}>
                                <span className={css.modelName}>{model.name}</span>
                                {isDefault && (
                                  <span className={css.defaultBadge}>
                                    {t("handoff.modal.defaultBadge")}
                                  </span>
                                )}
                              </span>
                              {model.description !== undefined && model.description !== "" && (
                                <span className={css.modelDesc}>{model.description}</span>
                              )}
                            </span>
                            {selected && (
                              <IconCheckOutlineRegular size={14} className={css.checkIcon} />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {submitError !== null && (
          <div className={css.errorBox} role="alert">
            <span className={css.errorText}>
              {t("handoff.modal.failed", { message: submitError })}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
