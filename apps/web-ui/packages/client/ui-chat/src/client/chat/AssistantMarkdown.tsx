import { Fragment, memo, useMemo, useState } from "react";
import { fileMediaUrl } from "@deepseek-ai/dsh-util-workspace-path";
import type { ReactNode } from "react";
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  JsonBlock,
  MarkdownText,
  useMarkdownDelegate,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  MarkdownFileMentions,
  MarkdownPathImages,
  MarkdownResponseAnnotations,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  ChatNodeOwnerProps,
  ChatViewSlotProps,
  UseDisclosure,
  UsePresentation,
} from "../contract/slots.ts";
import type { AssistantBlock } from "../contract/snapshot.ts";
import { markdownLabels } from "../markdown-labels.ts";
import { ReasoningRow } from "./ReasoningRow.tsx";
import { useSearchableHidden } from "./searchable-hidden.ts";
import css from "./AssistantMarkdown.module.css";

function ViewedImages({
  images,
  renderMessageImages,
  t,
}: {
  images: readonly {
    attachment: Extract<AssistantBlock, { kind: "viewed-images" }>["attachment"];
  }[];
  renderMessageImages: ChatNodeOwnerProps["renderMessageImages"];
  t: ChatViewSlotProps["t"];
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    images.length === 1
      ? t("message.imageViews.one")
      : t("message.imageViews.many", { count: images.length });
  return (
    <div className={css.viewedImages}>
      <button
        type="button"
        className={css.viewedImagesToggle}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((open) => !open);
        }}
      >
        <span className={css.viewedImagesIcon} aria-hidden="true" />
        <span>{title}</span>
        {expanded ? (
          <IconChevronUpOutlineRegular className={css.viewedImagesChevron} />
        ) : (
          <IconChevronDownOutlineRegular className={css.viewedImagesChevron} />
        )}
      </button>
      {expanded && renderMessageImages({ images, align: "start" })}
    </div>
  );
}

/**
 * Standalone fallback for image destinations (query/fragment suffixes are ignored).
 * Chat fileImages resolves decoded file references against cwd; pathImages also
 * serves this component outside that provider and accepts legacy image URL suffixes.
 * Resolve an authored absolute image path against the document's file API.
 * @param base - canonical `document.baseURI` at render time.
 * @param value - authored Markdown destination; URL escapes are decoded once.
 * @param resolve - Owning view's local-image policy, when present; a miss cannot fall back locally.
 * @returns an absolute Web or Desktop file-API URL, or undefined for unsupported
 * protocols and non-local paths.
 */
export function localPathMediaUrl(
  base: string,
  value: string,
  resolve?: (path: string) => string | undefined,
): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(value.split(/[?#]/u)[0] ?? "");
  } catch {
    return undefined;
  } // Malformed URL escapes cannot identify a file.
  return resolve === undefined ? fileMediaUrl(base, path) : resolve(path);
}

export interface AssistantMarkdownProps {
  /** Render only the requested business portion, preserving original block indexes. */
  groupPart?: string | undefined;
  /** Stable Hook forwarded to each independently expandable reasoning block. */
  useDisclosure: UseDisclosure;
  blocks: readonly AssistantBlock[];
  streaming: boolean;
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined;
  /** Render consecutive image blocks through the attachment slot. */
  renderMessageImages: ChatNodeOwnerProps["renderMessageImages"];
  /** Hide reasoning that belongs to the Turn-level process disclosure. */
  reasoningHidden?: boolean | undefined;
  /** Live display policy for reasoning summaries. */
  usePresentation: UsePresentation;
  /** Reveal the disclosure that hides this reasoning. */
  revealProcess?: (() => void) | undefined;
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined;
  /** How the reply's annotation citations resolve, when its Turn carries any. */
  responseAnnotations?: MarkdownResponseAnnotations | undefined;
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps["t"];
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks,
  streaming,
  interrupted,
  renderMessageImages,
  groupPart,
  useDisclosure,
  reasoningHidden = false,
  usePresentation,
  revealProcess,
  mentions,
  responseAnnotations,
  t,
}: AssistantMarkdownProps) {
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t]);
  const { fileImages } = useMarkdownDelegate();
  // MarkdownText memoizes its vocabulary; keep its identity stable across renders.
  const pathImages = useMemo<MarkdownPathImages>(() => {
    return { resolve: (value) => localPathMediaUrl(document.baseURI, value, fileImages?.resolve) };
  }, [fileImages]);
  const last = blocks.length - 1;
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible =
    streaming || interrupted === true || blocks.some((block) => block.kind !== "tool-call");
  if (!hasVisible) return null;
  const rendered: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (groupPart === "reasoning" && block.kind !== "reasoning") continue;
    if (groupPart === "response" && block.kind === "reasoning") continue;
    switch (block.kind) {
      case "text":
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            breaks
            labels={labels}
            fileMentions={mentions}
            pathImages={pathImages}
            responseAnnotations={responseAnnotations}
          />,
        );
        break;
      case "reasoning":
        rendered.push(
          <ProcessReasoning key={i} hidden={reasoningHidden} reveal={revealProcess}>
            <ReasoningRow
              text={block.text}
              running={streaming && i === last}
              usePresentation={usePresentation}
              useDisclosure={useDisclosure}
              t={t}
            />
          </ProcessReasoning>,
        );
        break;
      case "image": {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i;
        const group = [block];
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1];
          if (next === undefined || next.kind !== "image") break;
          group.push(next);
          i += 1;
        }
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({ attachment })),
              align: "start",
            })}
          </Fragment>,
        );
        break;
      }
      case "viewed-images": {
        // Native view_image results share one collapsed disclosure while keeping
        // every image available through the existing gallery/lightbox.
        const start = i;
        const group = [block];
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1];
          if (next === undefined || next.kind !== "viewed-images") break;
          group.push(next);
          i += 1;
        }
        rendered.push(
          <ViewedImages
            key={start}
            images={group.map(({ attachment }) => ({ attachment }))}
            renderMessageImages={renderMessageImages}
            t={t}
          />,
        );
        break;
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case "tool-call":
        break;
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t("message.unknownBlock")}
            payload={block.block}
            truncatedLabel={(total) => t("json.truncated", { total })}
          />,
        );
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted &&
          (groupPart === undefined ||
            groupPart === "response" ||
            !blocks.some((block) => block.kind !== "reasoning" && block.kind !== "tool-call")) && (
            <span className={css.stopped}>{t("message.stopped")}</span>
          )}
      </div>
    </div>
  );
});

function ProcessReasoning({
  hidden,
  reveal,
  children,
}: {
  hidden: boolean;
  reveal?: (() => void) | undefined;
  children: ReactNode;
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP);
  return (
    <div ref={ref} data-turn-process-inline={hidden || undefined}>
      {children}
    </div>
  );
}

const NOOP = (): void => {};
