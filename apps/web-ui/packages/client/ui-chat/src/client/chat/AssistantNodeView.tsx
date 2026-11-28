import { memo, useCallback, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  ChatNodeViewProps,
  PresentationInjected,
  TurnTailOwnerProps,
} from "../contract/slots.ts";
import { AssistantMarkdown } from "./AssistantMarkdown.tsx";
import { ResponseAnnotationMarks } from "./ResponseAnnotationMarks.tsx";
import { annotationLabels } from "../markdown-labels.ts";
import { clampMultiClickSelection } from "./response-selection.ts";
import type {
  MarkdownFileMentions,
  MarkdownResponseAnnotations,
} from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./SelectionActions.module.css";

function insideAnnotationMark(element: Element | null, host: Element): boolean {
  for (let node = element; node !== null && node !== host; node = node.parentElement) {
    if (node.classList.contains(css.annotationMark)) return true;
  }
  return false;
}

type AssistantNodeViewProps = ChatNodeViewProps<"assistant-step"> &
  InjectFace<PresentationInjected>;

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node,
  groupPart,
  useDisclosure,
  useTurnData,
  turnProcess,
  openFile,
  renderMessageImages,
  fileMentions,
  responseAnnotations,
  useInput,
  inputActions,
  usePresentation,
  t,
}: AssistantNodeViewProps) {
  const data = node.data;
  const answer = useRef<HTMLDivElement>(null);
  const answerKey = JSON.stringify([node.key, groupPart ?? null]);
  const turn =
    node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : undefined;
  const tail = useTurnData("turn-tail");
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== "closed" || data.finalNode === undefined) return undefined;
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined;
    return { turn, seq: data.finalNode.seq, openFile };
  }, [data.finalNode, openFile, tail, turn]);
  const mentions = useMemo(
    () => (owner === undefined ? undefined : fileMentions(owner)),
    [fileMentions, owner],
  );
  // Harness file citations open through the view's own openFile, independent
  // of the Turn-tail mention vocabulary: a citation names the file it read.
  const fileCitations = useMemo<MarkdownFileMentions | undefined>(() => {
    if (openFile === undefined) return undefined;
    return {
      resolve: (path: string) => {
        if (path.trim() === "") return undefined;
        return {
          open: () => {
            void openFile(path);
          },
          label: path,
          title: path,
        };
      },
    };
  }, [openFile]);
  const reasoningHidden =
    turnProcess !== undefined &&
    turnProcess.foldable &&
    turnProcess.spec.answerStep === data.step &&
    turnProcess.spec.inlineReasoning &&
    !turnProcess.open;
  const revealProcess = useCallback(() => {
    turnProcess?.setOpen(true);
  }, [turnProcess]);
  // Stable pair for the Markdown cache: a new identity would discard the
  // streaming render mid-message, so it changes only with content or locale.
  const citationLabels = useMemo(() => annotationLabels(t), [t]);
  const citations = useMemo<MarkdownResponseAnnotations>(
    () => ({
      labels: citationLabels,
      resolve: (index) => responseAnnotations[index - 1],
    }),
    [citationLabels, responseAnnotations],
  );
  const onAnswerClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.detail >= 2 && answer.current !== null) {
      clampMultiClickSelection(answer.current, insideAnnotationMark);
    }
  }, []);
  return (
    <div
      ref={answer}
      className={css.answer}
      data-selection-answer={answerKey}
      data-selection-answer-streaming={data.status === "running" || undefined}
      onClick={onAnswerClick}
    >
      <AssistantMarkdown
        blocks={data.blocks}
        groupPart={groupPart}
        useDisclosure={useDisclosure}
        streaming={data.status === "running"}
        interrupted={data.status === "interrupted"}
        renderMessageImages={renderMessageImages}
        reasoningHidden={reasoningHidden}
        usePresentation={usePresentation}
        revealProcess={revealProcess}
        mentions={mentions}
        fileCitations={fileCitations}
        responseAnnotations={citations}
        t={t}
      />
      {data.status !== "running" && (
        <ResponseAnnotationMarks
          answer={answer}
          answerKey={answerKey}
          useInput={useInput}
          inputActions={inputActions}
          labels={citationLabels}
        />
      )}
    </div>
  );
});
