/** Composer takeover for one pending approval waterfall. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApprovalCard,
  type ApprovalCardAction,
  type ApprovalCardFileDiff,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ApprovalComposerProps, PendingApproval } from "./contract/slots.ts";

const META_LINE_RE = /^(?:工作目录|Working directory|原因|Reason)\s*[:：]/i;

interface ParsedApprovalReason {
  readonly headline: string;
  readonly command?: string | undefined;
  readonly files?: readonly ApprovalCardFileDiff[] | undefined;
  readonly detail?: string | undefined;
}

function looksLikePathList(block: string): boolean {
  if (META_LINE_RE.test(block)) return false;
  if (/[。！？]$/.test(block)) return false;
  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) => !/\s{1,}[a-z]+.*\.$/.test(line) && (/[\\/.]/.test(line) || lines.length === 1),
  );
}

function parseReason(
  toolName: string,
  reason: string | undefined,
  fallbackHeadline: string,
): ParsedApprovalReason {
  const trimmed = reason?.trim();
  if (!trimmed) return { headline: fallbackHeadline };
  const parts = trimmed
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { headline: parts[0] ?? fallbackHeadline };

  const [headline = fallbackHeadline, second = "", ...rest] = parts;
  if (toolName === "shell" && !META_LINE_RE.test(second)) {
    const detail = rest.join("\n").trim();
    return {
      headline,
      command: second,
      ...(detail ? { detail } : {}),
    };
  }
  if (toolName === "files" && looksLikePathList(second)) {
    const files = second
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => ({ path }));
    const detail = rest.join("\n").trim();
    return {
      headline,
      ...(files.length > 0 ? { files } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  return {
    headline,
    detail: parts.slice(1).join("\n"),
  };
}

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched;
  const detail =
    approval.callId === undefined
      ? null
      : props.renderSlot("conversation.approval.detail", { callId: approval.callId });
  const reason =
    approval.displayReason === undefined
      ? approval.reason
      : props.resolveReason(approval.displayReason);
  return (
    <ApprovalFlow
      key={approval.key}
      pending={approval}
      reason={reason}
      detail={detail}
      t={props.t}
    />
  );
}

function ApprovalFlow({
  pending,
  reason,
  detail,
  t,
}: {
  pending: PendingApproval;
  reason: string | undefined;
  detail: ReactNode;
  t: ApprovalComposerProps["t"];
}) {
  const [answered, setAnswered] = useState(false);
  const waiting = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const answer = (outcome: "allowed-once" | "rejected"): void => {
    if (waiting.current || !pending.answerable) return;
    waiting.current = true;
    setAnswered(true);
    void pending.answer(outcome).catch(() => {
      if (!active.current || !pending.answerable) return;
      waiting.current = false;
      setAnswered(false);
    });
  };

  const parsed = useMemo(
    () => parseReason(pending.toolName, reason, t("escalation", { toolName: pending.toolName })),
    [pending.toolName, reason, t],
  );

  const actions = useMemo<ApprovalCardAction[]>(
    () => [
      { id: "rejected", label: t("reject"), effect: "deny" },
      { id: "allowed-once", label: t("allowOnce"), effect: "allowOnce" },
    ],
    [t],
  );

  return (
    <ApprovalCard
      cardKey={pending.key}
      headline={parsed.headline}
      meta={pending.toolName === "shell" ? "bash" : pending.toolName}
      command={parsed.command}
      commandSlot={detail}
      files={parsed.files}
      detail={parsed.detail}
      actions={actions}
      busy={answered}
      onAction={(action) => {
        answer(action.id === "allowed-once" ? "allowed-once" : "rejected");
      }}
      labels={{
        detailAria: t("detail.aria"),
        expand: t("expand"),
        collapse: t("collapse"),
        moreOptions: t("moreOptions"),
        categoryTerminal: t("categoryTerminal"),
        categoryFiles: t("categoryFiles"),
        categoryPermission: t("categoryPermission"),
      }}
    />
  );
}
