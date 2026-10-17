import {
  IconChevronDownOutlineRegular,
  IconNewChatOutlineRegular,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { UNGROUPED_KEY } from "../tree.ts";
import css from "./RecentHeader.module.css";

/** Recents is a loose-session account, not a folder or a registered project. */
export function RecentHeader({
  expanded,
  canCreate,
  onToggle,
  onCreate,
  t,
}: {
  expanded: boolean;
  canCreate: boolean;
  onToggle: () => void;
  onCreate: () => void;
  t: WorkspaceBrowserProps["t"];
}) {
  return (
    <div
      className={css.row}
      role="treeitem"
      tabIndex={0}
      data-row-key={`workspace:${UNGROUPED_KEY}`}
      aria-label={t("group.ungrouped")}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className={css.title}>{t("group.ungrouped")}</span>
      <IconChevronDownOutlineRegular className={expanded ? css.chevron : css.collapsed} size={12} />
      {canCreate && (
        <Tooltip label={t("actions.newSession")} portal>
          <button
            type="button"
            className={css.create}
            aria-label={t("actions.newSession")}
            onClick={(event) => {
              event.stopPropagation();
              onCreate();
            }}
          >
            <IconNewChatOutlineRegular size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
