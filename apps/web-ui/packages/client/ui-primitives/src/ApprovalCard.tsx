import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconEditOutlineRegular,
  IconShieldOutlineRegular,
} from "./icons/index.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import css from "./ApprovalCard.module.css";

/** Semantic role for one approval decision button. */
export type ApprovalCardActionEffect = "allowOnce" | "allowForSession" | "allowAlways" | "deny";

/** One decision action rendered in the approval card footer. */
export interface ApprovalCardAction {
  readonly id: string;
  readonly label: string;
  readonly effect: ApprovalCardActionEffect;
  readonly tooltip?: string | undefined;
}

/** One file entry or unified diff rendered inside an approval card. */
export interface ApprovalCardFileDiff {
  readonly path: string;
  readonly diff?: string | undefined;
  readonly kind?: "add" | "update" | "delete" | undefined;
}

/** Localized strings supplied by the owning feature package. */
export interface ApprovalCardLabels {
  readonly detailAria: string;
  readonly expand: string;
  readonly collapse: string;
  readonly moreOptions: string;
  readonly categoryTerminal: string;
  readonly categoryFiles: string;
  readonly categoryPermission: string;
}

export interface ApprovalCardProps {
  /** Concise headline naming the pending operation. */
  headline: string;
  /** Quiet category tag (e.g., "bash", "files", or a tool name). */
  meta?: string | undefined;
  /** Shell command text rendered in a recessed monospace surface. */
  command?: string | undefined;
  /** Optional Slot-rendered command node (hidden automatically when empty). */
  commandSlot?: ReactNode | undefined;
  /** File changes or unified diffs rendered in a generous preview surface. */
  files?: readonly ApprovalCardFileDiff[] | undefined;
  /** Optional secondary text or detail rendered below the preview (or standalone). */
  detail?: ReactNode | undefined;
  /** Available native decision actions. */
  actions: readonly ApprovalCardAction[];
  /** Disables controls while settling. */
  busy?: boolean | undefined;
  /** Optional error feedback displayed above the actions. */
  error?: string | null | undefined;
  /** Called on button click, SplitButton menu selection, or Enter/Escape shortcut. */
  onAction: (action: ApprovalCardAction) => void;
  /** Localized labels for accessibility, categories, and expand/collapse toggles. */
  labels: ApprovalCardLabels;
  /** Optional stable render key exposed via data-approval-key. */
  cardKey?: string | undefined;
}

interface ParsedDiffRow {
  readonly kind: "file" | "add" | "del" | "ctx";
  readonly lineNumber: string;
  readonly text: string;
}

const DIFF_PREVIEW_LINE_CAP = 14;
const COMMAND_PREVIEW_LINE_CAP = 6;
const PATH_PREVIEW_LINE_CAP = 7;

function splitPathParts(rawPath: string): { dir: string; base: string } {
  const normalized = rawPath.replace(/\\/gu, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: normalized };
  return {
    dir: normalized.slice(0, idx + 1),
    base: normalized.slice(idx + 1) || normalized,
  };
}

function parseUnifiedDiffRows(files: readonly ApprovalCardFileDiff[]): {
  rows: ParsedDiffRow[];
  added: number;
  removed: number;
  hasDiffText: boolean;
} {
  const rows: ParsedDiffRow[] = [];
  let added = 0;
  let removed = 0;
  let hasDiffText = false;
  const showFileHeaders = files.length > 1;

  for (const file of files) {
    const raw = file.diff?.trimEnd();
    if (!raw) continue;
    hasDiffText = true;
    if (showFileHeaders) {
      rows.push({ kind: "file", lineNumber: "", text: file.path });
    }
    let oldLine = 1;
    let newLine = 1;
    for (const line of raw.split(/\r?\n/u)) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("\\ No newline")
      ) {
        continue;
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        continue;
      }
      if (line.startsWith("+")) {
        added += 1;
        rows.push({ kind: "add", lineNumber: String(newLine), text: line.slice(1) });
        newLine += 1;
      } else if (line.startsWith("-")) {
        removed += 1;
        rows.push({ kind: "del", lineNumber: String(oldLine), text: line.slice(1) });
        oldLine += 1;
      } else {
        const text = line.startsWith(" ") ? line.slice(1) : line;
        rows.push({ kind: "ctx", lineNumber: String(newLine), text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { rows, added, removed, hasDiffText };
}

export function partitionApprovalCardActions(actions: readonly ApprovalCardAction[]): {
  primaryDeny: ApprovalCardAction | undefined;
  secondaryDenies: ApprovalCardAction[];
  primaryAllow: ApprovalCardAction | undefined;
  secondaryAllows: ApprovalCardAction[];
} {
  const denies = actions.filter((action) => action.effect === "deny");
  const allows = actions.filter((action) => action.effect !== "deny");
  const primaryDeny = denies[0];
  const secondaryDenies = denies.slice(1);
  const primaryAllow = allows.find((action) => action.effect === "allowOnce") ?? allows[0];
  const secondaryAllows = allows.filter((action) => action !== primaryAllow);
  return { primaryDeny, secondaryDenies, primaryAllow, secondaryAllows };
}

function TerminalGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 5 6.5 8 3 11" />
      <line x1="8" y1="11" x2="13" y2="11" />
    </svg>
  );
}

/**
 * Shared Codex Desktop–style approval card: neutral rounded-3xl surface, two-tier
 * wireframe-icon header, generous diff/command preview, monochrome pill actions,
 * borderless inline keycaps, and a SplitButton dropdown for scoped allow options.
 */
export function ApprovalCard({
  headline,
  meta,
  command,
  commandSlot,
  files,
  detail,
  actions,
  busy = false,
  error = null,
  onAction,
  labels,
  cardKey,
}: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [allowMenuOpen, setAllowMenuOpen] = useState(false);
  const [denyMenuOpen, setDenyMenuOpen] = useState(false);
  const composing = useRef(false);
  const compositionEnded = useRef(false);

  const parsedDiff = useMemo(() => parseUnifiedDiffRows(files ?? []), [files]);
  const { primaryDeny, secondaryDenies, primaryAllow, secondaryAllows } = useMemo(
    () => partitionApprovalCardActions(actions),
    [actions],
  );

  const trimmedCommand = command?.trim();
  const commandLines = trimmedCommand ? trimmedCommand.split(/\r?\n/u).length : 0;
  const isCommandLong =
    trimmedCommand !== undefined &&
    (commandLines > COMMAND_PREVIEW_LINE_CAP || trimmedCommand.length > 360);
  const isDiffLong = parsedDiff.rows.length > DIFF_PREVIEW_LINE_CAP;
  const pathList = !parsedDiff.hasDiffText ? (files ?? []).map((file) => file.path) : [];
  const isPathListLong = pathList.length > PATH_PREVIEW_LINE_CAP;

  // Reset local disclosure/menu state when a new approval takes over the seat.
  useEffect(() => {
    setExpanded(false);
    setAllowMenuOpen(false);
    setDenyMenuOpen(false);
  }, [cardKey, headline]);

  useEffect(() => {
    if (busy) {
      setAllowMenuOpen(false);
      setDenyMenuOpen(false);
    }
  }, [busy]);

  const allowMenuItems = useMemo<MenuItem[]>(() => {
    if (primaryAllow === undefined || secondaryAllows.length === 0) return [];
    return [primaryAllow, ...secondaryAllows].map((action) => ({
      id: action.id,
      label: action.label,
      disabled: busy,
    }));
  }, [primaryAllow, secondaryAllows, busy]);

  const denyMenuItems = useMemo<MenuItem[]>(() => {
    if (primaryDeny === undefined || secondaryDenies.length === 0) return [];
    return [primaryDeny, ...secondaryDenies].map((action) => ({
      id: action.id,
      label: action.label,
      disabled: busy,
    }));
  }, [primaryDeny, secondaryDenies, busy]);

  const actionById = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions],
  );

  const allowMenuActive = allowMenuOpen && secondaryAllows.length > 0;
  const denyMenuActive = denyMenuOpen && secondaryDenies.length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (busy || allowMenuActive || denyMenuActive) return;
    const element = event.target as Element;
    if (
      event.defaultPrevented ||
      !event.currentTarget.contains(document.activeElement) ||
      element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !==
        null
    )
      return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (event.key === "Enter" && element.closest('button, a[href], [role="button"]') !== null)
      return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.key === "Enter" ? primaryAllow : primaryDeny;
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (
      event.repeat ||
      composing.current ||
      compositionEnded.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    onAction(target);
  };

  const isTerminal = meta === "bash" || meta === "shell" || Boolean(trimmedCommand);
  const isFiles = meta === "files" || (files !== undefined && files.length > 0);
  const categoryLabel = isTerminal
    ? labels.categoryTerminal
    : isFiles
      ? labels.categoryFiles
      : meta && meta.trim() !== ""
        ? meta
        : labels.categoryPermission;

  const hasDiffStats = parsedDiff.added > 0 || parsedDiff.removed > 0;
  const firstFile = files?.[0];
  const singleDiffFile =
    files?.length === 1 && firstFile !== undefined ? splitPathParts(firstFile.path) : null;
  const hasDetail = detail !== undefined && detail !== null && detail !== false && detail !== "";
  const hasCommandSlot =
    !parsedDiff.hasDiffText &&
    !trimmedCommand &&
    pathList.length === 0 &&
    commandSlot !== undefined &&
    commandSlot !== null &&
    commandSlot !== false;
  const hasPrimarySurface =
    parsedDiff.hasDiffText || Boolean(trimmedCommand) || pathList.length > 0 || hasCommandSlot;
  const hasBody = hasPrimarySurface || hasDetail;

  const renderDenyAction = () => {
    if (primaryDeny === undefined) return null;
    if (secondaryDenies.length === 0) {
      return (
        <button
          type="button"
          className={clsx(css.pill, css.pillOutline)}
          title={primaryDeny.tooltip}
          disabled={busy}
          onClick={() => {
            setAllowMenuOpen(false);
            setDenyMenuOpen(false);
            onAction(primaryDeny);
          }}
        >
          <span className={css.btnLabel}>{primaryDeny.label}</span>
          <kbd className={css.kbd} aria-hidden="true">
            Esc
          </kbd>
        </button>
      );
    }

    const denySplitTrigger = (
      <div className={clsx(css.splitGroup, css.splitOutline, busy && css.splitDisabled)}>
        <button
          type="button"
          className={css.splitPrimary}
          title={primaryDeny.tooltip}
          disabled={busy}
          onClick={() => {
            setAllowMenuOpen(false);
            setDenyMenuOpen(false);
            onAction(primaryDeny);
          }}
        >
          <span className={css.btnLabel}>{primaryDeny.label}</span>
          <kbd className={css.kbd} aria-hidden="true">
            Esc
          </kbd>
        </button>
        <span className={css.splitDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.splitCaret}
          aria-label={`${primaryDeny.label} · ${labels.moreOptions}`}
          aria-haspopup="menu"
          aria-expanded={denyMenuOpen}
          disabled={busy}
          onClick={() => {
            setAllowMenuOpen(false);
            setDenyMenuOpen((open) => !open);
          }}
        >
          <IconChevronDownOutlineRegular size={13} />
        </button>
      </div>
    );

    return (
      <Menu
        open={denyMenuOpen}
        onClose={() => {
          setDenyMenuOpen(false);
        }}
        side="top"
        align="end"
        portal
        compact
        items={denyMenuItems}
        onSelect={(id) => {
          setDenyMenuOpen(false);
          const chosen = actionById.get(id);
          if (chosen !== undefined) onAction(chosen);
        }}
        anchor={denySplitTrigger}
        className={css.splitMenuAnchor}
        listClassName={css.splitMenuList}
      />
    );
  };

  const renderPrimaryAllow = () => {
    if (primaryAllow === undefined) return null;
    if (secondaryAllows.length === 0) {
      return (
        <button
          type="button"
          className={clsx(css.pill, css.pillPrimary)}
          title={primaryAllow.tooltip}
          disabled={busy}
          onClick={() => {
            setAllowMenuOpen(false);
            setDenyMenuOpen(false);
            onAction(primaryAllow);
          }}
        >
          <span className={css.btnLabel}>{primaryAllow.label}</span>
          <kbd className={css.kbd} aria-hidden="true">
            ↵
          </kbd>
        </button>
      );
    }

    const splitTrigger = (
      <div className={clsx(css.splitGroup, busy && css.splitDisabled)}>
        <button
          type="button"
          className={css.splitPrimary}
          title={primaryAllow.tooltip}
          disabled={busy}
          onClick={() => {
            setAllowMenuOpen(false);
            setDenyMenuOpen(false);
            onAction(primaryAllow);
          }}
        >
          <span className={css.btnLabel}>{primaryAllow.label}</span>
          <kbd className={css.kbd} aria-hidden="true">
            ↵
          </kbd>
        </button>
        <span className={css.splitDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.splitCaret}
          aria-label={`${primaryAllow.label} · ${labels.moreOptions}`}
          aria-haspopup="menu"
          aria-expanded={allowMenuOpen}
          disabled={busy}
          onClick={() => {
            setDenyMenuOpen(false);
            setAllowMenuOpen((open) => !open);
          }}
        >
          <IconChevronDownOutlineRegular size={13} />
        </button>
      </div>
    );

    return (
      <Menu
        open={allowMenuOpen}
        onClose={() => {
          setAllowMenuOpen(false);
        }}
        side="top"
        align="end"
        portal
        compact
        items={allowMenuItems}
        onSelect={(id) => {
          setAllowMenuOpen(false);
          const chosen = actionById.get(id);
          if (chosen !== undefined) onAction(chosen);
        }}
        anchor={splitTrigger}
        className={css.splitMenuAnchor}
        listClassName={css.splitMenuList}
      />
    );
  };

  return (
    <div
      className={css.root}
      data-approval-key={cardKey}
      aria-busy={busy}
      onKeyDown={handleKeyDown}
      onKeyUpCapture={() => {
        compositionEnded.current = false;
      }}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
        compositionEnded.current = true;
      }}
    >
      <section className={clsx(css.card, busy && css.cardBusy)} aria-label={headline}>
        <div className={css.header}>
          <div className={css.eyebrow}>
            <span className={css.categoryIcon} aria-hidden="true">
              {isTerminal ? (
                <TerminalGlyph />
              ) : isFiles ? (
                <IconEditOutlineRegular size={15} />
              ) : (
                <IconShieldOutlineRegular size={15} />
              )}
            </span>
            <span className={css.categoryLabel}>{categoryLabel}</span>
          </div>
          <div className={css.headline}>{headline}</div>
        </div>

        {hasBody && (
          <div
            className={css.body}
            data-approval-scroll=""
            tabIndex={0}
            role="group"
            aria-label={labels.detailAria}
          >
            {parsedDiff.hasDiffText ? (
              <div className={clsx(css.diffSurface, expanded && css.expanded)}>
                {(singleDiffFile !== null || hasDiffStats) && (
                  <div className={css.diffTopBar}>
                    {singleDiffFile !== null ? (
                      <span className={css.diffPath} title={files?.[0]?.path}>
                        {singleDiffFile.dir !== "" && (
                          <span className={css.diffPathDir}>{singleDiffFile.dir}</span>
                        )}
                        <span className={css.diffPathBase}>{singleDiffFile.base}</span>
                      </span>
                    ) : (
                      <span className={css.diffPath}>
                        <span className={css.diffPathBase}>{files?.length ?? 0} files</span>
                      </span>
                    )}
                    {hasDiffStats && (
                      <span className={css.diffStats} aria-hidden="true">
                        {parsedDiff.added > 0 && (
                          <span className={css.diffAddStat}>+{parsedDiff.added}</span>
                        )}
                        {parsedDiff.removed > 0 && (
                          <span className={css.diffDelStat}>−{parsedDiff.removed}</span>
                        )}
                      </span>
                    )}
                  </div>
                )}
                <div className={clsx(css.diffBodyWrap, isDiffLong && !expanded && css.faded)}>
                  <div className={css.diffLines}>
                    {parsedDiff.rows.map((row, idx) =>
                      row.kind === "file" ? (
                        <div key={idx} className={css.diffFileHeader}>
                          {row.text}
                        </div>
                      ) : (
                        <div
                          key={idx}
                          className={clsx(
                            css.diffRow,
                            row.kind === "add" && css.diffAdd,
                            row.kind === "del" && css.diffDel,
                            row.kind === "ctx" && css.diffCtx,
                          )}
                        >
                          <span className={css.lineNumber}>{row.lineNumber}</span>
                          <span className={css.lineText}>{row.text || " "}</span>
                        </div>
                      ),
                    )}
                  </div>
                </div>
                {isDiffLong && (
                  <div className={css.surfaceFooter}>
                    <button
                      type="button"
                      className={css.expandToggle}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpanded((value) => !value);
                      }}
                    >
                      {expanded ? labels.collapse : labels.expand}
                    </button>
                  </div>
                )}
              </div>
            ) : trimmedCommand ? (
              <div className={clsx(css.codeSurface, expanded && css.expanded)}>
                <div className={clsx(css.codeBodyWrap, isCommandLong && !expanded && css.faded)}>
                  <pre className={css.codeText}>{trimmedCommand}</pre>
                </div>
                {isCommandLong && (
                  <div className={css.surfaceFooter}>
                    <button
                      type="button"
                      className={css.expandToggle}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpanded((value) => !value);
                      }}
                    >
                      {expanded ? labels.collapse : labels.expand}
                    </button>
                  </div>
                )}
              </div>
            ) : pathList.length > 0 ? (
              <div className={clsx(css.codeSurface, expanded && css.expanded)}>
                <div className={clsx(css.codeBodyWrap, isPathListLong && !expanded && css.faded)}>
                  <div className={css.pathList}>
                    {pathList.map((filePath) => {
                      const parts = splitPathParts(filePath);
                      return (
                        <div key={filePath} className={css.pathRow} title={filePath}>
                          {parts.dir !== "" && <span className={css.diffPathDir}>{parts.dir}</span>}
                          <span className={css.diffPathBase}>{parts.base}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {isPathListLong && (
                  <div className={css.surfaceFooter}>
                    <button
                      type="button"
                      className={css.expandToggle}
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpanded((value) => !value);
                      }}
                    >
                      {expanded ? labels.collapse : labels.expand}
                    </button>
                  </div>
                )}
              </div>
            ) : hasCommandSlot ? (
              <div className={clsx(css.codeSurface, css.slotSurface)}>
                <div className={css.codeText}>{commandSlot}</div>
              </div>
            ) : null}
            {hasDetail && (
              <div className={clsx(css.detailText, hasPrimarySurface && css.detailAfterSurface)}>
                {detail}
              </div>
            )}
          </div>
        )}

        {error !== null && error !== "" && (
          <div className={css.error} role="status">
            {error}
          </div>
        )}

        <div
          className={css.footer}
          data-action-count={(primaryDeny ? 1 : 0) + (primaryAllow ? 1 : 0)}
        >
          {renderDenyAction()}
          {renderPrimaryAllow()}
        </div>
      </section>
    </div>
  );
}
