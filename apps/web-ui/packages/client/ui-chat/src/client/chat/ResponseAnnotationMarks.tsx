import { useLayoutEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { DraftResponseAnnotation } from "@deepseek-ai/dsh-client-ui-conversation/client";
import {
  ResponseAnnotationPopover,
  type ResponseAnnotationLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { restoreResponseAnnotationRange } from "./response-selection.ts";
import css from "./SelectionActions.module.css";

const HIGHLIGHT_NAME = "codexhost-response-annotation";
const MARK_HEIGHT = 24;

export function lastSelectionRect(range: Range): DOMRect | undefined {
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? undefined : rect;
}

/** Paint ranges without changing the Markdown elements or native selection. */
export function highlightResponseRanges(ranges: readonly Range[]): () => void {
  const registry = globalThis.CSS?.highlights;
  if (ranges.length === 0 || registry === undefined || typeof Highlight === "undefined")
    return () => {};
  const highlight = registry.get(HIGHLIGHT_NAME) ?? new Highlight();
  for (const range of ranges) highlight.add(range);
  registry.set(HIGHLIGHT_NAME, highlight);
  return () => {
    for (const range of ranges) highlight.delete(range);
    if (highlight.size === 0) registry.delete(HIGHLIGHT_NAME);
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
  labels,
}: {
  answer: RefObject<HTMLDivElement>;
  answerKey: string;
  useInput: ChatViewSlotProps["useInput"];
  labels: ResponseAnnotationLabels;
}) {
  const annotations = useInput((state) => state.responseAnnotations);
  const attached = useMemo(
    () =>
      annotations?.flatMap((annotation, index) =>
        annotation.anchor?.answerKey === answerKey ? [{ annotation, index: index + 1 }] : [],
      ),
    [annotations, answerKey],
  );
  const [marks, setMarks] = useState(NO_MARKS);

  useLayoutEffect(() => {
    const host = answer.current;
    if (host === null || attached === undefined || attached.length === 0) {
      setMarks(NO_MARKS);
      return;
    }
    let ranges: Array<IndexedAnnotation & { range: Range }> = [];
    let clearHighlight = () => {};
    const place = () => {
      const hostTop = host.getBoundingClientRect().top;
      const located = ranges.flatMap(({ annotation, index, range }) => {
        const rect = lastSelectionRect(range);
        return rect === undefined
          ? []
          : [{ annotation, index, top: rect.top - hostTop + (rect.height - MARK_HEIGHT) / 2 }];
      });
      located.sort((a, b) => a.top - b.top);
      let nextTop = 0;
      setMarks(
        located.map((mark) => {
          const top = Math.max(mark.top, nextTop);
          nextTop = top + MARK_HEIGHT + 2;
          return { ...mark, top };
        }),
      );
    };
    const restore = () => {
      clearHighlight();
      ranges = attached.flatMap((entry) => {
        const { anchor, text } = entry.annotation;
        const range = anchor && restoreResponseAnnotationRange(host, anchor, text);
        return range === undefined ? [] : [{ ...entry, range }];
      });
      clearHighlight = highlightResponseRanges(ranges.map(({ range }) => range));
      place();
    };
    restore();
    const resize = new ResizeObserver(place);
    resize.observe(host);
    const mutations = new MutationObserver(restore);
    const markdown = host.firstElementChild;
    if (markdown !== null)
      mutations.observe(markdown, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "open"],
      });
    host.addEventListener("scroll", place, true);
    return () => {
      clearHighlight();
      resize.disconnect();
      mutations.disconnect();
      host.removeEventListener("scroll", place, true);
    };
  }, [answer, attached]);

  return marks.map(({ annotation, index, top }) => (
    <div key={annotation.id} className={css.annotationMark} style={{ top }} data-selection-actions>
      <ResponseAnnotationPopover
        annotation={annotation}
        labels={labels}
        title={labels.label(index)}
        anchor={
          <span className={css.annotationNumber} aria-label={labels.label(index)}>
            {index}
          </span>
        }
      />
    </div>
  ));
}
