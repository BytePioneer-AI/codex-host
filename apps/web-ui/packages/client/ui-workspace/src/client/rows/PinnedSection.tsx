import type { ComponentProps, DragEvent, ReactNode } from "react";
import clsx from "clsx";
import { IconPinOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionNode } from "../tree.ts";
import { type RowDragProps, SessionNodeItem } from "./Rows.tsx";
import { SectionHeading } from "./SectionHeading.tsx";
import { isManageableCustomSection, type SectionDropTarget } from "./section-dnd.ts";
import { PINNED_SECTION_KEY } from "../stores.ts";
import { ThreadTreeRows } from "./ThreadTreeControls.tsx";
import css from "./PinnedSection.module.css";

type RowProps = ComponentProps<typeof SessionNodeItem>;

/** Desktop fine-pointer drag interaction shared across custom sections. */
export interface SectionDragInteraction {
  readonly active: boolean;
  readonly draggedSessionId: SessionId | null;
  readonly over: SectionDropTarget | null;
  readonly canDragRow: (node: SessionNode) => boolean;
  readonly startFromSection: (sessionId: SessionId, sectionId: string) => void;
  readonly hoverSectionEnd: (sectionId: string) => void;
  readonly hoverSectionRow: (
    sectionId: string,
    targetSessionId: SessionId,
    half: "before" | "after",
  ) => void;
  readonly dropSectionEnd: (sectionId: string, dropEffect?: string | null) => void;
  readonly dropSectionRow: (
    sectionId: string,
    targetSessionId: SessionId,
    half: "before" | "after",
    dropEffect?: string | null,
  ) => void;
  readonly clearHover: () => void;
  readonly end: () => void;
}

/**
 * One projection of the shared pin order or a native custom section.
 * Pinned never accepts section drops; manageable custom sections accept
 * desktop fine-pointer drops onto their heading, rows, and empty drop zone.
 */
export function PinnedSection({
  rows,
  customSection,
  headingActions,
  sectionDrag,
  currentId,
  onOpen,
  onRenameRequest,
  renderSlot,
  useMovingSectionSessions,
  t,
  revealSessionId,
  onSessionRevealed,
  showHost = true,
  expanded,
  onToggle,
  children,
  hasWorkspaces = false,
}: Pick<
  RowProps,
  "currentId" | "onOpen" | "onRenameRequest" | "renderSlot" | "useMovingSectionSessions" | "t"
> & {
  rows: readonly SessionNode[];
  customSection?: {
    key: string;
    section: WorkspaceThreadSection;
    projectDrop?: ComponentProps<typeof SectionHeading>["projectDrop"];
  };
  headingActions?: ReactNode;
  sectionDrag?: SectionDragInteraction;
  revealSessionId?: RowProps["currentId"];
  onSessionRevealed: (id: SessionNode["id"]) => void;
  showHost?: boolean;
  /** Whether the section's rows show. */
  expanded: boolean;
  /** Fold or unfold the section. */
  onToggle: () => void;
  /** Rows after the section's own Threads, shown while it is expanded (its Workspaces). */
  children?: ReactNode;
  /** Workspace rows can keep the section visible even when it has no Sessions. */
  hasWorkspaces?: boolean;
}) {
  if (rows.length === 0 && !hasWorkspaces && !customSection) return null;
  const section = customSection?.section;
  const label = section?.name ?? t("section.pinned");
  const isCustomManageable = section !== undefined && isManageableCustomSection(section);
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  const acceptsSectionDrop =
    isCustomManageable && section !== undefined && sectionDrag?.active === true;
  const isSectionEndTarget =
    acceptsSectionDrop &&
    sectionDrag.over?.kind === "section-end" &&
    sectionDrag.over.sectionId === section.id;
  const handleSectionEndDragOver =
    acceptsSectionDrop && section !== undefined
      ? (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          sectionDrag.hoverSectionEnd(section.id);
        }
      : undefined;
  const handleSectionEndDrop =
    acceptsSectionDrop && section !== undefined
      ? (event: DragEvent<HTMLDivElement>) => {
          if (event.dataTransfer.dropEffect === "copy") return;
          event.preventDefault();
          event.stopPropagation();
          sectionDrag.dropSectionEnd(section.id, event.dataTransfer.dropEffect);
        }
      : undefined;
  return (
    <div
      role="group"
      aria-label={label}
      className={css.section}
      data-sidebar-pinned={customSection ? undefined : true}
      data-sidebar-custom-section={section?.id}
      onDragOver={
        !customSection && sectionDrag?.active
          ? () => {
              sectionDrag.clearHover();
            }
          : undefined
      }
    >
      <SectionHeading
        label={label}
        icon={customSection ? undefined : <IconPinOutlineRegular size={14} />}
        trailing={headingActions}
        expanded={expanded}
        onToggle={onToggle}
        rowKey={`section:${customSection?.key ?? PINNED_SECTION_KEY}`}
        projectDrop={customSection?.projectDrop}
        dropTarget={isSectionEndTarget}
        onDragOver={handleSectionEndDragOver}
        onDrop={handleSectionEndDrop}
      />
      {expanded && rows.length > 0 && (
        <ThreadTreeRows roots={rows}>
          {(node) => {
            const rowDrag: RowDragProps | undefined =
              isCustomManageable && section !== undefined && sectionDrag !== undefined
                ? {
                    canDrag: sectionDrag.canDragRow(node),
                    start: () => {
                      sectionDrag.startFromSection(node.id, section.id);
                    },
                    active:
                      sectionDrag.active &&
                      !node.blank &&
                      !node.archived &&
                      node.id !== sectionDrag.draggedSessionId,
                    marker:
                      sectionDrag.over?.kind === "section-row" &&
                      sectionDrag.over.sectionId === section.id &&
                      sectionDrag.over.targetSessionId === node.id
                        ? sectionDrag.over.half
                        : null,
                    hover: (half) => {
                      sectionDrag.hoverSectionRow(section.id, node.id, half);
                    },
                    drop: (half, dropEffect) => {
                      sectionDrag.dropSectionRow(section.id, node.id, half, dropEffect);
                    },
                    end: () => {
                      sectionDrag.end();
                    },
                  }
                : undefined;
            return (
              <SessionNodeItem
                key={node.id}
                node={node}
                showHost={showHost}
                currentId={currentId}
                now={Date.now()}
                onOpen={onOpen}
                onRenameRequest={onRenameRequest}
                renderSlot={renderSlot}
                onReveal={
                  node.id === revealSessionId ? () => onSessionRevealed(node.id) : undefined
                }
                drag={rowDrag}
                useMovingSectionSessions={useMovingSectionSessions}
                t={t}
              />
            );
          }}
        </ThreadTreeRows>
      )}
      {expanded && hasChildren && children}
      {expanded && customSection !== undefined && rows.length === 0 && !hasChildren && (
        <div
          className={clsx(css.empty, isSectionEndTarget && css.emptyDropTarget)}
          data-section-drop-empty={section?.id}
          onDragOver={handleSectionEndDragOver}
          onDrop={handleSectionEndDrop}
        >
          {t("section.empty")}
        </div>
      )}
    </div>
  );
}
