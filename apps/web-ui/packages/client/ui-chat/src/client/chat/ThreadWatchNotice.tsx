/** Display-only projection; message actions retain the complete logged notice text. */
import { useSyncExternalStore } from "react";
import type { ThreadWatchNoticeEntry } from "@codexhost/shared-contracts";
import {
  IconBellOutlineRegular,
  MarkdownAnchor,
  ReferenceIconRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatLinks, ChatViewSlotProps } from "../contract/slots.ts";
import css from "./ThreadWatchNotice.module.css";

const noChanges = () => () => {};

function NoticeEntry({
  entry,
  links,
  t,
}: {
  entry: ThreadWatchNoticeEntry;
  links: ChatLinks | undefined;
  t: ChatViewSlotProps["t"];
}) {
  const href = `codex://threads/${entry.threadId}`;
  const title = () => links?.describe?.(href)?.title;
  const currentTitle = useSyncExternalStore(links?.resolve.subscribe ?? noChanges, title, title);
  const known = currentTitle !== undefined;
  return (
    <li className={css.entry} data-thread-watch-entry={entry.threadId}>
      <div className={css.line}>
        {known ? links?.describe?.(href)?.icon : <ReferenceIconRegular kind="session" size={14} />}
        <span className={css.title} title={currentTitle ?? entry.label}>
          {currentTitle ?? entry.label}
        </span>
        <span className={css.outcome} data-outcome={entry.outcome}>
          {t(`message.watch.${entry.outcome}`)}
        </span>
        {known && (
          <span className={css.open}>
            <MarkdownAnchor href={href} glyph={false}>
              {[t("message.watch.open")]}
            </MarkdownAnchor>
          </span>
        )}
      </div>
      {entry.note !== undefined && <div className={css.note}>{entry.note}</div>}
    </li>
  );
}

export function ThreadWatchNotice({
  entries,
  links,
  t,
}: {
  entries: readonly ThreadWatchNoticeEntry[];
  links: ChatLinks | undefined;
  t: ChatViewSlotProps["t"];
}) {
  return (
    <div className={css.card} data-thread-watch-notice>
      <IconBellOutlineRegular className={css.bell} />
      <ul className={css.list}>
        {entries.map((entry, index) => (
          <NoticeEntry key={index} entry={entry} links={links} t={t} />
        ))}
      </ul>
    </div>
  );
}
