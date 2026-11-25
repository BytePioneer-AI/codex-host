import { memo, useId, useState } from "react";
import type { ThreadHandoffMetadata } from "@codexhost/shared-contracts";
import { IconChevronDownOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import {
  formatHandoffEndpointLabel,
  HandoffHarnessIcon,
  HandoffSwapIcon,
} from "./handoff-utils.tsx";
import css from "./HandoffDivider.module.css";

export interface HandoffDividerProps {
  readonly handoff: ThreadHandoffMetadata;
  readonly hostId?: string | undefined;
  readonly onOpenSource: (sourceThreadId: string) => void;
  readonly t: ChatViewSlotProps["t"];
}

/**
 * Centered context-handoff divider mounted at the top of a handed-off Thread.
 * Clicking toggles a compact summary card with source-session navigation and
 * a scrollable read-only preview of the carried context.
 */
export const HandoffDivider = memo(function HandoffDivider({
  handoff,
  hostId,
  onOpenSource,
  t,
}: HandoffDividerProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const source = formatHandoffEndpointLabel({
    harnessId: handoff.sourceHarnessId,
    harnessLabel: handoff.sourceHarnessLabel,
    model: handoff.sourceModel,
  });
  const target = formatHandoffEndpointLabel({
    harnessId: handoff.targetHarnessId,
    harnessLabel: handoff.targetHarnessLabel,
    model: handoff.targetModel,
  });
  const includedCount = handoff.includedTurnNumbers.length;
  const turnSummary =
    handoff.omittedTurns > 0
      ? t("handoff.divider.turnsPartial", {
          included: includedCount,
          total: handoff.totalTurns,
          omitted: handoff.omittedTurns,
          boundary: handoff.boundaryTurnNumber,
        })
      : handoff.boundaryTurnNumber < handoff.totalTurns
        ? t("handoff.divider.turnsPrefix", {
            boundary: handoff.boundaryTurnNumber,
            total: handoff.totalTurns,
          })
        : t("handoff.divider.turnsAll", {
            total: handoff.totalTurns,
          });
  const preview = handoff.preview.trim();

  return (
    <section className={css.root} data-handoff-divider="" aria-label={t("handoff.divider.label")}>
      <div className={css.dividerBar}>
        <span className={css.line} aria-hidden="true" />
        <button
          type="button"
          className={css.trigger}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? t("handoff.divider.collapse") : t("handoff.divider.expand")}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          <span className={css.titleGroup}>
            <HandoffSwapIcon size={14} className={css.swapIcon} />
            <span>{t("handoff.divider.label")}</span>
          </span>
          <span className={css.endpoints}>
            <span className={css.endpoint} title={source.title}>
              <HandoffHarnessIcon
                harnessId={handoff.sourceHarnessId}
                label={handoff.sourceHarnessLabel ?? handoff.sourceHarnessId}
                hostId={hostId}
                size={15}
              />
              <span className={css.sourceLabel}>{source.display}</span>
            </span>
            <span className={css.arrow} aria-hidden="true">
              →
            </span>
            <span className={css.endpoint} title={target.title}>
              <HandoffHarnessIcon
                harnessId={handoff.targetHarnessId}
                label={handoff.targetHarnessLabel ?? handoff.targetHarnessId}
                hostId={hostId}
                size={15}
              />
              <span className={css.targetLabel}>{target.display}</span>
            </span>
          </span>
          <span
            className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
            aria-hidden="true"
          >
            <IconChevronDownOutlineRegular size={12} />
          </span>
        </button>
        <span className={css.line} aria-hidden="true" />
      </div>

      {expanded && (
        <div id={panelId} className={css.panel} data-handoff-panel="">
          <div className={css.panelHeader}>
            <span className={css.turnSummary}>{turnSummary}</span>
            <button
              type="button"
              className={css.sourceButton}
              onClick={() => {
                onOpenSource(handoff.sourceThreadId);
              }}
            >
              <span>{t("handoff.divider.openSource")}</span>
              <span aria-hidden="true">↗</span>
            </button>
          </div>
          <div className={preview === "" ? `${css.preview} ${css.previewEmpty}` : css.preview}>
            {preview === "" ? t("handoff.divider.previewEmpty") : handoff.preview}
          </div>
        </div>
      )}
    </section>
  );
});
