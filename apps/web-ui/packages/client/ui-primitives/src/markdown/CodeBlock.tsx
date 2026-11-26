import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import clsx from "clsx";
import { writeClipboard } from "../clipboard.ts";
import { CodeToolbar, type CodeToolbarLabels } from "../CodeToolbar.tsx";
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from "../icons/index.tsx";
import {
  StreamingHighlightSession,
  grammarLoadCount,
  highlightToHtml,
  subscribeGrammarLoaded,
} from "./highlight.ts";
import type { HighlightSpan, StreamingHighlightFrame } from "./highlight.ts";
import { useCodeBlockFoldMemory } from "./MarkdownDelegate.tsx";
import { useViewportHighlighting } from "./useViewportHighlighting.ts";
import css from "./CodeBlock.module.css";

/** Settled collapsible blocks with more than this many lines start folded. */
export const FOLD_LINE_THRESHOLD = 20;
/** Number of leading lines rendered and highlighted while a block is folded. */
export const FOLD_PREVIEW_LINES = 8;

const defaultExpandCodeLabel = (totalLines: number): string => `Expand all (${totalLines} lines)`;
const DEFAULT_COLLAPSE_CODE_LABEL = "Collapse code";

function inspectCodeLines(
  text: string,
  previewLines: number,
): { readonly totalLines: number; readonly previewEnd: number } {
  let totalLines = 1;
  let previewEnd = text.length;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (totalLines === previewLines) {
      previewEnd = text[index - 1] === "\r" ? index - 1 : index;
    }
    totalLines += 1;
  }
  return { totalLines, previewEnd };
}

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string;
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined;
  /**
   * The code is still growing (a streaming markdown fence): highlight through
   * a per-instance {@link StreamingHighlightSession}, which re-tokenizes only
   * appended text and keeps completed line groups (and DOM) untouched. The
   * caller must keep the component instance stable across growth (a
   * stream-stable React key); an unchanged streamed fence also retains that
   * tree when it settles. Cold settled callers get shiki's HTML.
   */
  streaming?: boolean | undefined;
  /** Fold settled code blocks taller than {@link FOLD_LINE_THRESHOLD} lines by default. */
  collapsible?: boolean | undefined;
  /** Stable identifier within the enclosing row so expanded state survives virtualized remounts. */
  foldKey?: string | undefined;
  /** Label for expanding a folded block (receives total line count); defaults to English. */
  expandCodeLabel?: ((totalLines: number) => string) | undefined;
  /** Label for collapsing an expanded foldable block; defaults to English. */
  collapseCodeLabel?: string | undefined;
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined;
  /** Ref for the stable source-content wrapper, for owners that use it as a scrollport. */
  contentRef?: Ref<HTMLDivElement> | undefined;
  /** Show a numbered gutter without adding numbers to copied source. Defaults to false. */
  lineNumbers?: boolean | undefined;
  /** Show the language and copy header; false when the caller supplies a toolbar. Defaults to true. */
  showHeader?: boolean | undefined;
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel: string;
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string;
  /** Enable the shared card toolbar and spacing; omit for custom toolbar layouts. */
  toolbarLabels?: CodeToolbarLabels | undefined;
  /** With toolbarLabels, use the owner's wrapping preference and omit the toolbar's local wrap action. */
  wrap?: boolean | undefined;
}

/**
 * The `pre` attributes shiki's HTML arm emits for the css-variables theme,
 * mirrored so the streaming arm's tree is interchangeable with the settled
 * swap (`tests/streaming-code-block.client.spec.tsx` pins the two arms'
 * parity).
 */
const SHIKI_PRE_PROPS = {
  className: "shiki css-variables",
  style: { backgroundColor: "var(--shiki-background)", color: "var(--shiki-foreground)" },
  tabIndex: 0,
} as const;

/** Completed-line group size; React reconciles groups while the DOM remains line-for-line identical. */
const STREAMING_LINE_GROUP_SIZE = 32;

function renderLine(line: readonly HighlightSpan[], index: number): ReactNode {
  return (
    <Fragment key={index}>
      {index > 0 && "\n"}
      <span className="line">
        {line.map((span, spanIndex) => (
          <span key={spanIndex} style={span.style}>
            {span.text}
          </span>
        ))}
      </span>
    </Fragment>
  );
}

export function CodeBlock({
  code,
  lang,
  streaming,
  collapsible = false,
  foldKey,
  expandCodeLabel = defaultExpandCodeLabel,
  collapseCodeLabel = DEFAULT_COLLAPSE_CODE_LABEL,
  className,
  contentRef,
  lineNumbers = false,
  showHeader = true,
  copyLabel,
  copiedLabel,
  toolbarLabels,
  wrap,
}: CodeBlockProps) {
  const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
  const foldMemory = useCodeBlockFoldMemory();
  const memoryKey =
    foldKey === undefined
      ? undefined
      : `${foldKey}\0${lang ?? ""}\0${trimmed.length}\0${trimmed.slice(0, 64)}`;
  // Blocks that mount while streaming or were previously expanded in this row
  // stay expanded; only untouched settled historical blocks start collapsed.
  const [expanded, setExpanded] = useState(
    () => streaming === true || (memoryKey !== undefined && foldMemory?.get(memoryKey) === true),
  );
  const prevStreamingRef = useRef(streaming === true);
  if (streaming === true && !prevStreamingRef.current) {
    prevStreamingRef.current = true;
    if (!expanded) setExpanded(true);
  } else if (streaming !== true && prevStreamingRef.current) {
    prevStreamingRef.current = false;
  }
  const lineMetrics = useMemo(
    () => (collapsible ? inspectCodeLines(trimmed, FOLD_PREVIEW_LINES) : undefined),
    [collapsible, trimmed],
  );
  const totalLines = lineMetrics?.totalLines ?? 0;
  const canFold = collapsible && streaming !== true && totalLines > FOLD_LINE_THRESHOLD;
  useEffect(() => {
    if (canFold && expanded && memoryKey !== undefined && foldMemory !== undefined) {
      if (foldMemory.get(memoryKey) !== true) foldMemory.set(memoryKey, true);
    }
  }, [canFold, expanded, foldMemory, memoryKey]);
  const folded = canFold && !expanded;
  const displayCode =
    folded && lineMetrics !== undefined ? trimmed.slice(0, lineMetrics.previewEnd) : trimmed;
  const sourceLines = lineNumbers ? displayCode.split("\n") : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const highlighting = useViewportHighlighting(rootRef, lang);
  // Re-render when a lazy grammar finishes loading, so a fence that showed plain
  // text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount);
  // Streaming state lives in refs mutated inside the memo (the MarkdownText
  // streaming-cache pattern): the session's caches carry across chunks only
  // because the owner keys this instance stably while the fence grows.
  const sessionRef = useRef<StreamingHighlightSession | null>(null);
  const lineCacheRef = useRef<{
    code: string;
    lang: string | undefined;
    generation: number;
    frame: StreamingHighlightFrame;
    groups: ReactNode[];
    pending: ReactNode[];
    nextLine: number;
    body: ReactNode;
  } | null>(null);
  const settledRef = useRef(false);
  const streamedBody = useMemo(() => {
    if (!highlighting) {
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = false;
      return undefined;
    }
    if (streaming !== true) {
      const previous = lineCacheRef.current;
      if (previous !== null && previous.code === displayCode && previous.lang === lang) {
        settledRef.current = true;
        return previous.body;
      }
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = true;
      return undefined;
    }
    if (settledRef.current) {
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = false;
    }
    sessionRef.current ??= new StreamingHighlightSession();
    const frame = sessionRef.current.updateFrame(displayCode, lang);
    if (frame === undefined) {
      lineCacheRef.current = null;
      return undefined;
    }
    const previous = lineCacheRef.current;
    if (previous?.frame === frame && previous.code === displayCode && previous.lang === lang) {
      return previous.body;
    }
    const sameGeneration = previous?.generation === frame.generation;
    const groups = sameGeneration ? [...previous.groups] : [];
    let pending = sameGeneration ? [...previous.pending] : [];
    let nextLine = sameGeneration ? previous.nextLine : 0;
    for (const line of frame.appended) {
      pending.push(renderLine(line, nextLine));
      nextLine += 1;
      if (pending.length !== STREAMING_LINE_GROUP_SIZE) continue;
      const start = nextLine - pending.length;
      groups.push(<Fragment key={start}>{pending}</Fragment>);
      pending = [];
    }
    const tail = frame.tail.map((line, index) => renderLine(line, nextLine + index));
    const tailGroup = <Fragment key={nextLine - pending.length}>{[...pending, ...tail]}</Fragment>;
    const body = (
      <pre {...SHIKI_PRE_PROPS}>
        <code>
          {groups}
          {tailGroup}
        </code>
      </pre>
    );
    lineCacheRef.current = {
      code: displayCode,
      lang,
      generation: frame.generation,
      frame,
      groups,
      pending,
      nextLine,
      body,
    };
    return body;
  }, [streaming, highlighting, displayCode, lang, loaded]);
  const html = useMemo(
    () =>
      highlighting && streaming !== true && streamedBody === undefined
        ? highlightToHtml(displayCode, lang)
        : undefined,
    [streaming, highlighting, streamedBody, displayCode, lang, loaded],
  );
  const [copied, setCopied] = useState(false);
  const [localWrapped, setWrapped] = useState(true);
  const wrapped = wrap ?? localWrapped;

  const onCopy = useCallback(() => {
    if (copied) return;
    // Always copy the complete trimmed source regardless of folded preview state.
    void writeClipboard(trimmed).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1000);
    });
  }, [copied, trimmed]);

  const onToggleFold = useCallback(() => {
    setExpanded((value) => {
      const next = !value;
      if (memoryKey !== undefined) foldMemory?.set(memoryKey, next);
      return next;
    });
  }, [foldMemory, memoryKey]);

  // shiki's HTML output is a static span tree it generated from `code` (no
  // user HTML passes through), the sanctioned innerHTML consumption path per
  // shiki's own docs.
  const body =
    streamedBody !== undefined ? (
      streamedBody
    ) : html === undefined ? (
      <pre className={css.plain}>
        <code>
          {sourceLines === undefined
            ? displayCode
            : sourceLines.map((line, index) => (
                <Fragment key={index}>
                  {index > 0 && "\n"}
                  <span className="line">{line}</span>
                </Fragment>
              ))}
        </code>
      </pre>
    ) : (
      <div dangerouslySetInnerHTML={{ __html: html }} />
    );

  return (
    <div
      ref={rootRef}
      className={clsx(
        css.block,
        "md-code-block",
        lineNumbers && css.numbered,
        toolbarLabels !== undefined && css.card,
        canFold && css.foldable,
        className,
      )}
      data-line-numbers={lineNumbers || undefined}
      data-code-wrap={toolbarLabels === undefined ? undefined : wrapped}
      data-code-folded={canFold ? folded : undefined}
      style={
        sourceLines === undefined
          ? undefined
          : ({
              "--dsl-code-block-line-number-width": `${Math.max(2, String(sourceLines.length).length)}ch`,
            } as CSSProperties)
      }
    >
      {/* These paired attributes are stable semantic hooks for owner styling and DOM tests. */}
      {showHeader && (
        <div className={css.bannerWrap}>
          {toolbarLabels !== undefined ? (
            <CodeToolbar
              lang={lang}
              labels={toolbarLabels}
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
              copied={copied}
              wrapped={wrapped}
              onCopy={onCopy}
              onWrap={
                wrap === undefined
                  ? () => {
                      setWrapped((value) => !value);
                    }
                  : undefined
              }
            />
          ) : (
            <div className={css.banner} data-code-block-banner>
              <div className={css.infostring}>{lang ?? ""}</div>
              <div className={css.action}>
                <button type="button" className={css.copyButton} onClick={onCopy}>
                  {copied ? copiedLabel : copyLabel}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div ref={contentRef} className={css.content} data-code-block-content>
        {body}
      </div>
      {canFold && (
        <div className={clsx(css.foldBar, folded && css.foldFade)} data-code-block-controls>
          <button
            type="button"
            className={css.foldButton}
            aria-expanded={!folded}
            data-code-fold-toggle
            onClick={onToggleFold}
          >
            <span>{folded ? expandCodeLabel(totalLines) : collapseCodeLabel}</span>
            {folded ? (
              <IconChevronDownOutlineRegular size={12} className={css.foldIcon} />
            ) : (
              <IconChevronUpOutlineRegular size={12} className={css.foldIcon} />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
