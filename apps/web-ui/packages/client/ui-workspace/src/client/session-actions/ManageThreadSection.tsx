/** Dialogs and menu for creating, renaming, and deleting custom Thread sections. */
import { useRef, useState } from "react";
import {
  Button,
  IconEllipsisOutlineRegular,
  Menu,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  WorkspaceCreateThreadSectionValue,
  WorkspaceDeleteThreadSectionValue,
  WorkspaceThreadSection,
  WorkspaceUpdateThreadSectionValue,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import css from "../rows/WorkspaceBrowser.module.css";

export type ThreadSectionManageRequest =
  | { readonly mode: "create" }
  | { readonly mode: "rename"; readonly section: WorkspaceThreadSection }
  | { readonly mode: "delete"; readonly section: WorkspaceThreadSection };

export interface ThreadSectionManageInjected {
  hooks: {
    threadSectionManage: HostObservable<ThreadSectionManageRequest | null>;
  };
  dismiss: () => void;
  createSection: (name: string) => Promise<WorkspaceCreateThreadSectionValue>;
  updateSection: (sectionId: string, name: string) => Promise<WorkspaceUpdateThreadSectionValue>;
  deleteSection: (sectionId: string) => Promise<WorkspaceDeleteThreadSectionValue>;
  notifySyncPending: () => void;
}

type ManageProps = PropsLocale<"workspace"> & InjectFace<ThreadSectionManageInjected>;

export function ThreadSectionActions({
  section,
  request,
  t,
}: Pick<ManageProps, "t"> & {
  section: WorkspaceThreadSection;
  request: (request: ThreadSectionManageRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = t("actions.section.aria", { name: section.name });
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={[
        { id: "rename", label: t("section.rename.title") },
        { id: "delete", label: t("section.delete.title") },
      ]}
      onSelect={(id) => {
        setOpen(false);
        if (id === "rename" || id === "delete") request({ mode: id, section });
      }}
      align="end"
      dense
      portal
      anchor={
        <button
          type="button"
          className={css.iconButton}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <IconEllipsisOutlineRegular size={16} />
        </button>
      }
    />
  );
}

export function ManageThreadSectionDialog({
  useThreadSectionManage,
  dismiss,
  createSection,
  updateSection,
  deleteSection,
  notifySyncPending,
  t,
}: ManageProps) {
  const request = useThreadSectionManage((value) => value);
  if (request === null) return null;
  if (request.mode !== "delete") {
    const section = request.mode === "rename" ? request.section : undefined;
    return (
      <SectionNameDialog
        key={section ? `rename:${section.id}` : "create"}
        initialName={section?.name ?? ""}
        requireChange={section !== undefined}
        title={section ? t("section.rename.title") : t("section.create.title")}
        submitLabel={section ? t("rename") : t("section.create.action")}
        saveName={section ? (name) => updateSection(section.id, name) : createSection}
        dismiss={dismiss}
        notifySyncPending={notifySyncPending}
        t={t}
      />
    );
  }
  return (
    <DeleteSectionConfirm
      key={`delete:${request.section.id}`}
      section={request.section}
      dismiss={dismiss}
      deleteSection={deleteSection}
      notifySyncPending={notifySyncPending}
      t={t}
    />
  );
}

function SectionNameDialog({
  initialName,
  requireChange,
  title,
  submitLabel,
  saveName,
  dismiss,
  notifySyncPending,
  t,
}: Pick<ManageProps, "dismiss" | "notifySyncPending" | "t"> & {
  initialName: string;
  requireChange: boolean;
  title: string;
  submitLabel: string;
  saveName: ManageProps["createSection"];
}) {
  const [draft, setDraft] = useState(initialName);
  const [state, setState] = useState<"editing" | "saving" | "unknown">("editing");
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const submissionRef = useRef(false);
  const name = draft.trim();
  const invalid = name.length === 0 || (requireChange && name === initialName);
  const close = () => {
    if (state !== "saving") dismiss();
  };
  const submit = async () => {
    if (submissionRef.current || invalid) return;
    submissionRef.current = true;
    setState("saving");
    setError(null);
    try {
      const result = await saveName(name);
      if (result.status === "unknown") {
        setState("unknown");
        setError(t("section.outcomeUnknown"));
        return;
      }
      dismiss();
      if (result.syncPending) notifySyncPending();
    } catch (reason: unknown) {
      setError(errorMessage(reason));
      submissionRef.current = false;
      setState("editing");
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      onClose={close}
      closeLabel={t("close")}
      title={title}
      footer={
        <>
          <Button variant="outline" disabled={state === "saving"} onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={state !== "editing" || invalid}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <input
        className={css.renameInput}
        value={draft}
        placeholder={t("section.namePlaceholder")}
        aria-label={t("field.sectionName")}
        data-modal-autofocus
        disabled={state !== "editing"}
        onFocus={requireChange ? (event) => event.target.select() : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !composingRef.current) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error !== null && (
        <div className={css.renameError} role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}

function DeleteSectionConfirm({
  section,
  dismiss,
  deleteSection,
  notifySyncPending,
  t,
}: Pick<ManageProps, "dismiss" | "deleteSection" | "notifySyncPending" | "t"> & {
  section: WorkspaceThreadSection;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const close = () => {
    if (!pendingRef.current) dismiss();
  };
  const confirm = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteSection(section.id);
      if (result.status !== "confirmed") {
        setError(t("section.outcomeUnknown"));
        return;
      }
      dismiss();
      if (result.syncPending) notifySyncPending();
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      pendingRef.current = false;
      setDeleting(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      onClose={close}
      closeLabel={t("close")}
      title={t("section.delete.title")}
      description={t("section.delete.desc", { name: section.name })}
      footer={
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={deleting}
            onClick={() => void confirm()}
          >
            {t("section.delete.action")}
          </Button>
        </>
      }
    >
      {deleting && (
        <div className={css.deleteStatus} role="status">
          {t("section.delete.pending")}
        </div>
      )}
      {error !== null && (
        <div className={css.renameError} role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
