import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import clsx from "clsx";
import type {
  DraftAttachmentId,
  DraftResponseAnnotation,
  InputActions,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import {
  ResponseAnnotationPopover,
  type ResponseAnnotationLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { restoreResponseAnnotationRange } from "./response-selection.ts";
import css from "./SelectionActions.module.css";

const HIGHLIGHT_NAME = "codexhost-response-annotation";
const HOVER_HIGHLIGHT_NAME = "codexhost-response-annotation-hover";
const HOVER_HIGHLIGHT_PRIORITY = 1;
const MARK_HEIGHT = 24;

export function lastSelectionRect(range: Range): DOMRect | undefined {
  const rects = range.getClientRects();
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects[index];
    if (rect !== undefined && (rect.width !== 0 || rect.height !== 0)) return rect;
  }
  const fallback = range.getBoundingClientRect();
  return fallback.width === 0 && fallback.height === 0 ? undefined : fallback;
}

/** Paint ranges without changing the Markdown elements or native selection. */
export function highlightResponseRanges(
  ranges: readonly Range[],
  name: string = HIGHLIGHT_NAME,
  priority = 0,
): () => void {
  const registry = globalThis.CSS?.highlights;
  if (ranges.length === 0 || registry === undefined || typeof Highlight === "undefined")
    return () => {};
  const highlight = registry.get(name) ?? new Highlight();
  highlight.priority = priority;
  for (const range of ranges) highlight.add(range);
  registry.set(name, highlight);
  return () => {
    for (const range of ranges) highlight.delete(range);
    if (highlight.size === 0 && registry.get(name) === highlight) registry.delete(name);
  };
}

interface IndexedAnnotation {
  readonly annotation: DraftResponseAnnotation;
  readonly index: number;
}

interface Mark extends IndexedAnnotation {
  readonly top: number;
}

const NO_MARKS: readonly Mark[] = [];

export function ResponseAnnotationMarks({
  answer,
  answerKey,
  useInput,
  inputActions,
  labels,
}: {
  answer: RefObject<HTMLDivElement>;
  answerKey: string;
  useInput: ChatViewSlotProps["useInput"];
  inputActions?: InputActions | undefined;
  labels: ResponseAnnotationLabels;
}) {
  const annotations = useInput((state) => state.responseAnnotations);
  // Narrow subscription so hovering an annotation only re-renders its owning answer.
  const hoveredId = useInput((state) => {
    const id = state.hoveredResponseAnnotationId;
    if (id === undefined) return undefined;
    return state.responseAnnotations?.some(
      (annotation) => annotation.id === id && annotation.anchor?.answerKey === answerKey,
    )
      ? id
      : undefined;
  });
  const attached = useMemo(
    () =>
      annotations?.flatMap((annotation, index) =>
        annotation.anchor?.answerKey === answerKey ? [{ annotation, index: index + 1 }] : [],
      ),
    [annotations, answerKey],
  );
  const [marks, setMarks] = useState(NO_MARKS);
  const rangesRef = useRef<Array<IndexedAnnotation & { range: Range }>>([]);
  const [rangesVersion, setRangesVersion] = useState(0);
  const ownedHoverRef = useRef<DraftAttachmentId | null>(null);
  const inputActionsRef = useRef(inputActions);
  inputActionsRef.current = inputActions;

  useEffect(() => {
    return () => {
      if (ownedHoverRef.current !== null) {
        ownedHoverRef.current = null;
        inputActionsRef.current?.hoverResponseAnnotation(null);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const host = answer.current;
    if (host === null || attached === undefined || attached.length === 0) {
      rangesRef.current = [];
      setMarks(NO_MARKS);
      setRangesVersion((version) => version + 1);
      return;
    }
    let clearHighlight = () => {};
    const place = () => {
      if (!host.isConnected) return;
      const hostTop = host.getBoundingClientRect().top;
      const located = rangesRef.current.flatMap(({ annotation, index, range }) => {
        const rect = lastSelectionRect(range);
        return rect === undefined
          ? []
          : [{ annotation, index, top: rect.top - hostTop + (rect.height - MARK_HEIGHT) / 2 }];
      });
      located.sort((a, b) => a.top - b.top);
      let nextTop = 0;
      const placed =
        located.length === 0
          ? NO_MARKS
          : located.map((mark) => {
              const top = Math.max(mark.top, nextTop);
              nextTop = top + MARK_HEIGHT + 2;
              return { ...mark, top };
            });
      setMarks((previous) =>
        previous.length === placed.length &&
        previous.every(
          (item, index) =>
            item.annotation === placed[index]?.annotation &&
            item.index === placed[index]?.index &&
            Math.abs(item.top - (placed[index]?.top ?? 0)) < 0.5,
        )
          ? previous
          : placed,
      );
    };
    const restore = () => {
      clearHighlight();
      clearHighlight = () => {};
      if (!host.isConnected) {
        rangesRef.current = [];
        setMarks(NO_MARKS);
        setRangesVersion((version) => version + 1);
        return;
      }
      rangesRef.current = attached.flatMap((entry) => {
        const { anchor, text } = entry.annotation;
        const range = anchor && restoreResponseAnnotationRange(host, anchor, text);
        return range === undefined ? [] : [{ ...entry, range }];
      });
      clearHighlight = highlightResponseRanges(
        rangesRef.current.map(({ range }) => range),
        HIGHLIGHT_NAME,
      );
      setRangesVersion((version) => version + 1);
      place();
    };
    restore();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(host);
    const mutations =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(restore);
    const markdown = host.firstElementChild;
    if (markdown !== null && !markdown.hasAttribute("data-selection-actions"))
      mutations?.observe(markdown, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "open"],
      });
    host.addEventListener("scroll", place, true);
    return () => {
      clearHighlight();
      clearHighlight = () => {};
      rangesRef.current = [];
      resize?.disconnect();
      mutations?.disconnect();
      host.removeEventListener("scroll", place, true);
    };
  }, [answer, attached]);

  useLayoutEffect(() => {
    if (hoveredId === undefined) return;
    const hoveredRanges = rangesRef.current
      .filter(({ annotation }) => annotation.id === hoveredId)
      .map(({ range }) => range);
    return highlightResponseRanges(hoveredRanges, HOVER_HIGHLIGHT_NAME, HOVER_HIGHLIGHT_PRIORITY);
  }, [hoveredId, rangesVersion]);

  return marks.map(({ annotation, index, top }) => {
    const isHovered = hoveredId === annotation.id;
    return (
      <div
        key={annotation.id}
        className={css.annotationMark}
        style={{ top }}
        data-selection-actions
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          ownedHoverRef.current = annotation.id;
          inputActions?.hoverResponseAnnotation(annotation.id);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          if (ownedHoverRef.current === annotation.id) ownedHoverRef.current = null;
          inputActions?.hoverResponseAnnotation(null);
        }}
        onFocus={(event) => {
          if (event.target instanceof Element && event.target.matches(":focus-visible")) {
            ownedHoverRef.current = annotation.id;
            inputActions?.hoverResponseAnnotation(annotation.id);
          }
        }}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            hoveredId === annotation.id
          ) {
            if (ownedHoverRef.current === annotation.id) ownedHoverRef.current = null;
            inputActions?.hoverResponseAnnotation(null);
          }
        }}
      >
        <ResponseAnnotationPopover
          annotation={annotation}
          labels={labels}
          title={labels.label(index)}
          anchor={
            <span
              className={clsx(css.annotationNumber, isHovered && css.annotationNumberHovered)}
              data-hovered={isHovered || undefined}
              aria-label={labels.label(index)}
            >
              {index}
            </span>
          }
        />
      </div>
    );
  });
}
