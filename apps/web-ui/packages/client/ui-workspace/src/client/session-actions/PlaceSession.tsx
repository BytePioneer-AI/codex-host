/** Phone placement uses the row menu and searchable dialog. */
import { useMemo, useState } from "react";
import { Button, MenuItemButton, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { useSidebarTouch } from "../rows/use-sidebar-touch.ts";
import type {
  HostObservable,
  PropsHooks,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import { canPlaceThread, threadPlacementCandidates } from "../thread-tree-catalog.ts";
import { threadTreeParentOf, workspaceLabel } from "../tree.ts";
import css from "./PlaceSession.module.css";

export interface PlaceSessionInjected {
  hooks: { placementRequest: HostObservable<SessionId | null> };
  requestPlacement: (id: SessionId) => void;
  closePlacement: () => void;
  placeSession: (id: SessionId, parentId: SessionId | null) => Promise<boolean>;
}

type PlacementDialogProps = PropsRuntime<"shell.overlay"> &
  PropsLocale<"workspace"> &
  Omit<PlaceSessionInjected, "hooks"> &
  PropsHooks<PlaceSessionInjected["hooks"]>;

export function PlaceSessionMenuItems({
  sessionId,
  useSessions,
  useMenuOpenState,
  requestPlacement,
  placeSession,
  t,
}: SessionMenuItemProps<PlaceSessionInjected>) {
  const summary = useSessions((list) => list.byId[sessionId]);
  const [, setOpen] = useMenuOpenState();
  const touch = useSidebarTouch();
  if (!touch || !canPlaceThread(summary)) return null;
  return (
    <>
      <MenuItemButton
        onSelect={() => {
          setOpen(false);
          requestPlacement(sessionId);
        }}
      >
        {t("threadTree.moveUnder")}
      </MenuItemButton>
      {summary !== undefined && threadTreeParentOf(summary) !== null && (
        <MenuItemButton
          onSelect={() => {
            setOpen(false);
            void placeSession(sessionId, null);
          }}
        >
          {t("threadTree.moveToTop")}
        </MenuItemButton>
      )}
    </>
  );
}

export function PlaceSessionDialog(props: PlacementDialogProps) {
  const id = props.usePlacementRequest((value) => value);
  if (id === null) return null;
  return <PlacementForm key={id} {...props} sessionId={id} />;
}

function PlacementForm({
  sessionId,
  useSessions,
  useWorkspaces,
  closePlacement,
  placeSession,
  t,
}: PlacementDialogProps & { sessionId: SessionId }) {
  const list = useSessions((value) => value);
  const archivedIds = useWorkspaces((value) => value.archivedSessionIds);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(
    () => threadPlacementCandidates(list, sessionId, archivedIds, query),
    [list, sessionId, archivedIds, query],
  );
  return (
    <Modal
      phoneSidebar
      open
      onClose={() => {
        if (!busy) closePlacement();
      }}
      closeLabel={t("close")}
      title={t("threadTree.moveUnder")}
      footer={
        <Button variant="outline" disabled={busy} onClick={closePlacement}>
          {t("cancel")}
        </Button>
      }
    >
      <input
        className={css.search}
        data-modal-autofocus
        type="search"
        value={query}
        aria-label={t("threadTree.search")}
        placeholder={t("threadTree.search")}
        disabled={busy}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        className={css.candidates}
        role="group"
        aria-label={t("threadTree.targets")}
        aria-busy={busy}
      >
        {candidates.map((row) => (
          <button
            type="button"
            key={row.id}
            className={css.candidate}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void placeSession(sessionId, row.id).then((ok) => {
                if (!ok) setBusy(false);
              });
            }}
          >
            <span className={css.title}>{row.title?.trim() || t("session.untitled")}</span>
            <span className={css.meta}>{workspaceLabel(row.cwd)}</span>
          </button>
        ))}
        {candidates.length === 0 && <p role="status">{t("threadTree.noTargets")}</p>}
      </div>
    </Modal>
  );
}
