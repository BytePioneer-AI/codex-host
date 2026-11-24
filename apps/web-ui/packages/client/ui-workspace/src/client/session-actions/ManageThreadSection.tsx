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
  if (request.mode === "create") {
    return (
      <CreateSectionForm
        key="create"
        dismiss={dismiss}
        createSection={createSection}
        notifySyncPending={notifySyncPending}
        t={t}
      />
    );
  }
  if (request.mode === "rename") {
    return (
      <RenameSectionForm
        key={`rename:${request.section.id}`}
        section={request.section}
        dismiss={dismiss}
        updateSection={updateSection}
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

function CreateSectionForm({
  dismiss,
  createSection,
  notifySyncPending,
  t,
}: Pick<ManageProps, "dismiss" | "createSection" | "notifySyncPending" | "t">) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const pendingRef = useRef(false);
  const name = draft.trim();
  const blocked = submitting || name.length === 0;
  const close = () => {
    if (!pendingRef.current) dismiss();
  };
  const submit = async () => {
    if (pendingRef.current || name.length === 0) return;
    pendingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createSection(name);
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
      setSubmitting(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      onClose={close}
      closeLabel={t("close")}
      title={t("section.create.title")}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={blocked} onClick={() => void submit()}>
            {t("section.create.action")}
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
        disabled={submitting}
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

function RenameSectionForm({
  section,
  dismiss,
  updateSection,
  notifySyncPending,
  t,
}: Pick<ManageProps, "dismiss" | "updateSection" | "notifySyncPending" | "t"> & {
  section: WorkspaceThreadSection;
}) {
  const [draft, setDraft] = useState(section.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const pendingRef = useRef(false);
  const name = draft.trim();
  const unchanged = name === section.name;
  const blocked = submitting || name.length === 0 || unchanged;
  const close = () => {
    if (!pendingRef.current) dismiss();
  };
  const submit = async () => {
    if (pendingRef.current || name.length === 0 || unchanged) return;
    pendingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await updateSection(section.id, name);
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
      setSubmitting(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      onClose={close}
      closeLabel={t("close")}
      title={t("section.rename.title")}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={blocked} onClick={() => void submit()}>
            {t("rename")}
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
        disabled={submitting}
        onFocus={(event) => {
          event.target.select();
        }}
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
