/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only. Inline references follow the consumer's wrapping policy and keep long
 * labels within its width. Explicit CH `[@label](thread://...?hostId=...)` and
 * DSH `@[label](dsh-session:...)` forms fold to session labels; exact session labels
 * supplied by an adjacent recall decorate their bare `@label` mention; plain
 * `@name` word-boundary tokens decorate by shape alone; explicit Harness
 * delegation carriers fold to their name and plugin icon; explicit Harness
 * command carriers `[@/cmd](subagent://codexhost-command.*)` fold to `/cmd`
 * command chips; and a plain `/name`
 * token decorates only when the caller names it — a skill the host actually
 * loaded for that message (ui-chat reads the step's `skill-invocation`
 * injections) or the command a command-input bubble echoes — so `/123` or a
 * stray `/word` stays plain text. A `/name` token is whitespace-bounded like
 * the host skill gesture (`dsh-tool-skill`): it ends at whitespace or the
 * text end, so slash paths (`/nfs-hg/xxx`, `/plan.md`) and punctuation-glued
 * tokens (`/plan。`) stay plain even for a loaded name.
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { ReferenceIconRegular } from "./ReferenceIcon.tsx";
import { planUserTextRanges } from "./user-text-ranges.ts";
import css from "./user-text.module.css";
import markdownCss from "./markdown/MarkdownText.module.css";

/** Optional navigation supplied by consumers that can preview references. */
export interface UserTextReferences {
  /** Open a file path decoded from an `@` mention. */
  openFile: (path: string) => void;
  /** Open the source of a skill loaded for this message. */
  openSkill: (name: string) => void;
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as: the skills the
 * host loaded for this message, or the command a command bubble echoes
 * (unsent queue rows pass none).
 * @param slashKind - the chip kind those tokens render as.
 * @param references - optional file and skill preview actions; session and command tokens stay labels.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
  slashKind: "skill" | "command" = "skill",
  references?: UserTextReferences,
): ReactNode {
  const ranges = planUserTextRanges(text, sessionLabels, slashNames);
  const parts: ReactNode[] = [];
  let cursor = 0;
  const pushPlain = (from: number, to: number): void => {
    parts.push(
      <span key={`t${from}`} className={css.plainRun}>
        {text.slice(from, to)}
      </span>,
    );
  };
  for (const range of ranges) {
    if (range.start < cursor) continue;
    const { start: tokenStart, end, label, kind } = range;
    if (tokenStart > cursor) pushPlain(cursor, tokenStart);
    const referenceKind =
      kind === "skill"
        ? "skill"
        : kind === "harness"
          ? "harness"
          : kind === "session"
            ? "session"
            : kind === "command"
              ? undefined
              : label.startsWith("@")
                ? label.replace(/^@"|"$/gu, "").endsWith("/")
                  ? "folder"
                  : "file"
                : undefined;
    const chipKind = kind === "command" ? "command" : (referenceKind ?? slashKind);
    const displayLabel =
      range.display ??
      (referenceKind === undefined
        ? label
        : referenceKind === "session"
          ? label.slice(1)
          : (label.slice(1).replace(/^"|"$/gu, "").split(/[\\/]/u).filter(Boolean).at(-1) ??
            label.slice(1)));
    const contents = (
      <>
        {referenceKind !== undefined && (
          <ReferenceIconRegular
            kind={referenceKind === "harness" ? "session" : referenceKind}
            reference={label}
            size={16}
            className={css.refIcon}
          />
        )}
        {displayLabel}
      </>
    );
    const open =
      references === undefined || kind === "command"
        ? undefined
        : referenceKind === "file"
          ? () => {
              references.openFile(label.slice(1).replace(/^"|"$/gu, ""));
            }
          : referenceKind === undefined && slashKind === "skill"
            ? () => {
                references.openSkill(label.slice(1));
              }
            : undefined;
    const className = clsx(css.refChip, referenceKind === undefined && css.slashChip);
    parts.push(
      open === undefined ? (
        <span key={tokenStart} className={className} data-ref-chip={chipKind} title={label}>
          {contents}
        </span>
      ) : (
        <button
          key={tokenStart}
          type="button"
          className={clsx(className, markdownCss.fileMention)}
          data-ref-chip={chipKind}
          title={label}
          onClick={(event) => {
            if (
              event.detail > 1 ||
              (event.detail !== 0 &&
                event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)
            )
              return;
            open();
          }}
        >
          {contents}
        </button>
      ),
    );
    cursor = end;
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>;
  if (cursor < text.length) pushPlain(cursor, text.length);
  return <>{parts}</>;
}
