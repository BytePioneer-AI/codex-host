/** Window-chrome controls for the fully hidden sidebar (frame shell.leading seat). */
import clsx from "clsx";
import {
  IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
// Type-only: pulls the frame's shell.leading slot and root standard hook declarations.
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { SidebarRootInjected } from "./contract/slots.ts";
import css from "./HeaderLeadingControls.module.css";

/** Full props of the shell.leading occupant. */
export type HeaderLeadingControlsProps = PropsRuntime<"shell.leading"> &
  InjectFace<SidebarRootInjected> &
  PropsLocale<"sidebar">;

/**
 * Sidebar-open and New Session controls in the frame's window-chrome seat.
 * On macOS desktop a collapsed sidebar hides entirely (no rail), taking both
 * controls off screen; this occupant puts them back beside the traffic
 * lights. The frame mounts the seat only in that state and owns its
 * placement, so the occupant renders unconditionally.
 * @param props - Injected sidebar actions plus the sidebar locale seat.
 * @returns the two window-chrome controls.
 */
export function HeaderLeadingControls({
  toggleSidebar,
  startSession,
  useShortcuts,
  useSessions,
  useSessionStatus,
  useWorkspaces,
  t,
}: HeaderLeadingControlsProps) {
  const shortcut = useShortcuts((rows) => rows.find((row) => row.id === "sidebar.left.toggle"));
  const newShortcut = useShortcuts((rows) => rows.find((row) => row.id === "session.new"));
  const sessions = useSessions((state) => state.byId);
  const statuses = useSessionStatus((state) => state);
  const archived = useWorkspaces((state) => state.archivedSessionIds);
  let indicator: "warning" | "done" | undefined;
  for (const summary of Object.values(sessions)) {
    if (summary.blank || (summary.retainedBy.mainView ?? 0) > 0 || archived.includes(summary.id))
      continue;
    const status = statuses.get(summary.id);
    if (status === undefined) continue;
    if (status.pendingInteraction !== undefined) {
      indicator = "warning";
      break;
    }
    if (status.completionUnread) indicator = "done";
  }
  return (
    <div className={css.controls}>
      <Tooltip label={t("toggle.open")} shortcutKeys={shortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={clsx(css.iconButton, css.sidebarButton)}
          aria-label={t("toggle.open")}
          aria-keyshortcuts={shortcut?.aria}
          onClick={() => {
            toggleSidebar();
          }}
        >
          <IconPanelLeftOutlineRegular size={16} className={css.sidebarIcon} />
          {indicator !== undefined && (
            <span className={css.indicator} data-indicator={indicator} aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      <Tooltip label={t("session.new.label")} shortcutKeys={newShortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={clsx(css.iconButton, css.newSessionButton)}
          aria-label={t("session.new.label")}
          aria-keyshortcuts={newShortcut?.aria}
          onClick={() => {
            startSession();
          }}
        >
          <IconNewChatOutlineRegular size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
