/** End-of-Turn file summary with a compact file list and expandable diffs. */
import { memo, useMemo, useState } from "react";
import {
  DiffBlock,
  IconChevronDownOutlineRegular,
  IconFileDiffOutlineRegular,
  PathLabel,
  type DiffBlockLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatNodeStore } from "../contract/snapshot.ts";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { ChangeStat } from "./ChangeStat.tsx";
import { baseName, sumChanges, useTurnFileChanges } from "./turn-file-changes.ts";
import css from "./TurnChangesCard.module.css";

interface TurnChangesCardProps {
  readonly nodeStore: ChatNodeStore;
  readonly turn: number;
  readonly t: ChatViewSlotProps["t"];
}

/**
 * @param props - the Chat node store, the closed Turn and the Chat locale seat.
 * @returns the card, or nothing when the Turn changed no file.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
  nodeStore,
  turn,
  t,
}: TurnChangesCardProps) {
  const files = useTurnFileChanges(nodeStore, turn);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const labels = useMemo<DiffBlockLabels>(
    () => ({
      codeLabel: t("diff.code"),
      wrapLabel: t("diff.wrap"),
      unwrapLabel: t("diff.unwrap"),
      copy: t("diff.copy"),
      copied: t("diff.copied"),
      collapseAria: t("diff.collapseAria"),
      expandAria: (count) => t("diff.expandAria", { count }),
      collapse: t("diff.collapse"),
      expand: (count) => t("diff.expand", { count }),
    }),
    [t],
  );
  if (files.length === 0) return null;
  const { added, removed } = sumChanges(files);
  const [only] = files;
  const title =
    files.length === 1 && only !== undefined
      ? t("chat.fileEdited", { name: baseName(only.path) })
      : t("chat.filesEdited", { count: files.length });
  const open = files.some((file) => expandedPaths.has(file.path));
  const visibleFiles = showAllFiles ? files : files.slice(0, 3);
  const hiddenCount = files.length - visibleFiles.length;
  return (
    <section className={css.card} data-turn-changes={turn}>
      <div className={css.header}>
        <span className={css.icon} aria-hidden="true">
          <IconFileDiffOutlineRegular size={24} />
        </span>
        <span className={css.text}>
          <span className={css.title} title={title}>
            {title}
          </span>
          <ChangeStat added={added} removed={removed} />
        </span>
        <button
          type="button"
          className={css.review}
          aria-expanded={open}
          onClick={() => {
            setExpandedPaths(new Set(open ? [] : files.map((file) => file.path)));
            if (!open) setShowAllFiles(true);
          }}
        >
          {t(open ? "chat.hideChanges" : "chat.viewChanges")}
        </button>
      </div>
      {(files.length > 1 || open) && (
        <ul className={css.files}>
          {visibleFiles.map((file) => (
            <li key={file.path} className={css.file}>
              {files.length > 1 && (
                <button
                  type="button"
                  className={css.fileHead}
                  aria-expanded={expandedPaths.has(file.path)}
                  onClick={() => {
                    setExpandedPaths((paths) => {
                      const next = new Set(paths);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    });
                  }}
                >
                  <PathLabel path={file.path} className={css.path} />
                  <ChangeStat added={file.added} removed={file.removed} />
                </button>
              )}
              {expandedPaths.has(file.path) && (
                <div className={css.diff}>
                  <DiffBlock diffs={[...file.hunks]} labels={labels} maxLines={12} />
                </div>
              )}
            </li>
          ))}
          {files.length > 3 && (
            <li>
              <button
                type="button"
                className={css.more}
                aria-expanded={showAllFiles}
                onClick={() => setShowAllFiles((value) => !value)}
              >
                {hiddenCount > 0
                  ? t("chat.showMoreFiles", { count: hiddenCount })
                  : t("chat.collapseFiles")}
                <IconChevronDownOutlineRegular
                  size={16}
                  className={css.chevron}
                  data-open={showAllFiles}
                />
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
});
