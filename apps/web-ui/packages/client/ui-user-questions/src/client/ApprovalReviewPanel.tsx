import { useMemo, useState } from "react";
import { ApprovalCard, type ApprovalCardAction } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ApprovalReview, PendingQuestion, QuestionComposerProps } from "./contract/slots.ts";

export type ApprovalReviewPanelProps = {
  pending: PendingQuestion;
  review: ApprovalReview;
} & Pick<QuestionComposerProps, "t">;

/**
 * Render a Host/Harness approval routed through user-questions using the shared
 * Option B minimal approval card (one-click actions, recessed command/diff preview,
 * Enter/Esc keycaps).
 */
export function ApprovalReviewPanel({ pending, review, t }: ApprovalReviewPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = useMemo<ApprovalCardAction[]>(
    () =>
      review.actions.map((action, index) => ({
        id: `${String(index)}:${action.label}`,
        label: action.label,
        effect: action.effect,
        ...(action.description === undefined ? {} : { tooltip: action.description }),
      })),
    [review.actions],
  );

  const decide = (action: ApprovalCardAction): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const remote = pending.snapshot().channel === "rpc";
    void pending
      .answer({ answers: [{ id: review.id, selected: [action.label] }] })
      .then(() => {
        if (!remote) return;
        setBusy(false);
        void pending.dismiss().catch(() => {
          setError(t("status.sent"));
        });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <ApprovalCard
      cardKey={pending.key}
      headline={review.question}
      meta={review.toolLabel}
      command={review.command}
      files={review.files}
      detail={review.detail}
      actions={actions}
      busy={busy}
      error={error}
      onAction={decide}
      labels={{
        detailAria: t("approval.detailAria"),
        expand: t("approval.expand"),
        collapse: t("approval.collapse"),
        moreOptions: t("approval.moreOptions"),
        categoryTerminal: t("approval.categoryTerminal"),
        categoryFiles: t("approval.categoryFiles"),
        categoryPermission: t("approval.categoryPermission"),
      }}
    />
  );
}
