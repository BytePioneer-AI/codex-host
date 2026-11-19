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
import { useTurnDiffs } from "./use-turn-diffs.ts";
import a11yCss from "./accessibility.module.css";
import css from "./TurnChangesCard.module.css";

interface TurnChangesCardProps {
  readonly nodeStore: ChatNodeStore;
  readonly turn: number;
  readonly t: ChatViewSlotProps["t"];
  readonly useProjection: ChatViewSlotProps["useProjection"];
  readonly loadTurnDiffs?: ChatViewSlotProps["loadTurnDiffs"];
}

/**
 * @param props - the Chat node store, the closed Turn and the Chat locale seat.
 * @returns the card, or nothing when the Turn changed no file.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
  nodeStore,
  turn,
  t,
  useProjection,
  loadTurnDiffs,
}: TurnChangesCardProps) {
  const files = useTurnFileChanges(nodeStore, turn, useProjection);
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of files) {
      const name = baseName(file.path);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [files]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const full = useTurnDiffs(turn, files, expandedPaths, loadTurnDiffs);
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
          aria-label={t(open ? "chat.hideChanges" : "chat.viewChanges")}
          onClick={() => {
            setExpandedPaths(new Set(open ? [] : files.map((file) => file.path)));
            if (!open) setShowAllFiles(true);
          }}
        >
          <span className={css.reviewLabel}>
            {t(open ? "chat.hideChanges" : "chat.viewChanges")}
          </span>
          <IconChevronDownOutlineRegular size={16} className={css.mobileChevron} data-open={open} />
        </button>
      </div>
      {(files.length > 1 || open) && (
        <ul className={css.files}>
          {visibleFiles.map((file) => {
            const diffs = full.diffs(file);
            const name = baseName(file.path);
            return (
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
                    <IconFileDiffOutlineRegular size={16} className={css.mobileFileIcon} />
                    <PathLabel path={file.path} className={css.path} />
                    <span className={css.mobilePath}>
                      <span className={css.fileName} aria-hidden="true">
                        {name}
                      </span>
                      {(nameCounts.get(name) ?? 0) > 1 && (
                        <span className={css.directory} aria-hidden="true">
                          {file.path.slice(0, file.path.length - name.length)}
                        </span>
                      )}
                      <span className={a11yCss.visuallyHidden}>{file.path}</span>
                    </span>
                    <ChangeStat added={file.added} removed={file.removed} />
                    <IconChevronDownOutlineRegular
                      size={16}
                      className={css.mobileChevron}
                      data-open={expandedPaths.has(file.path)}
                    />
                  </button>
                )}
                {expandedPaths.has(file.path) && (
                  <div className={css.diff}>
                    <div className={css.mobileFullPath}>{file.path}</div>
                    {diffs !== undefined ? (
                      <DiffBlock
                        diffs={[...diffs]}
                        labels={labels}
                        maxLines={Infinity}
                        className={css.inlineDiff}
                      />
                    ) : full.error ? (
                      <div role="alert" className={css.diffStatus}>
                        {full.error}{" "}
                        <button type="button" onClick={full.retry}>
                          {t("chat.retryDiff")}
                        </button>
                      </div>
                    ) : (
                      <span role="status" className={css.diffStatus}>
                        {t("chat.loadingDiff")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
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
