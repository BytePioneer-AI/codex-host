import { useEffect, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import css from "./WorkspaceBrowser.module.css";

interface ProjectDefaultHarness {
  harnessId: string | null;
  harnesses: { id: string; name: string }[];
}

async function projectDefaultHarness(
  request: { workspaceId: WorkspaceId; harnessId?: string | null },
  signal?: AbortSignal,
): Promise<unknown> {
  const method = "workspace/defaultHarness";
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: globalThis.crypto?.randomUUID?.() ?? `project-default-${Date.now()}`,
      method,
      payload: { args: { request } },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { result } = (await response.json()) as {
    result: { ok: true; value: unknown } | { ok: false; error: { message: string } };
  };
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function ProjectDefaultHarnessDialog({
  workspaceId,
  title,
  t,
  onClose,
}: {
  workspaceId: WorkspaceId;
  title: string;
  t: WorkspaceBrowserProps["t"];
  onClose: () => void;
}) {
  const [config, setConfig] = useState<ProjectDefaultHarness>();
  const [selection, setSelection] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"loadFailed" | "saveFailed">();

  useEffect(() => {
    const load = new AbortController();
    void projectDefaultHarness({ workspaceId }, load.signal)
      .then((response) => {
        if (load.signal.aborted) return;
        const config = response as ProjectDefaultHarness;
        setConfig(config);
        setSelection(config.harnessId ?? "");
      })
      .catch(() => {
        if (!load.signal.aborted) setError("loadFailed");
      });
    return () => load.abort();
  }, [workspaceId]);

  const unchanged = config === undefined || selection === (config.harnessId ?? "");
  const close = () => {
    if (!saving) onClose();
  };
  const save = async () => {
    if (saving || unchanged) return;
    setSaving(true);
    setError(undefined);
    try {
      await projectDefaultHarness({ workspaceId, harnessId: selection || null });
      onClose();
    } catch {
      setError("saveFailed");
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      closeLabel={t("close")}
      title={t("defaultHarness.title")}
      description={t("defaultHarness.description", { name: title })}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={saving || unchanged} onClick={() => void save()}>
            {t("defaultHarness.save")}
          </Button>
        </>
      }
    >
      {config ? (
        <select
          className={css.renameInput}
          aria-label={t("defaultHarness.title")}
          value={selection}
          disabled={saving}
          onChange={(event) => setSelection(event.target.value)}
        >
          <option value="">{t("defaultHarness.inherit")}</option>
          {config.harnessId && !config.harnesses.some(({ id }) => id === config.harnessId) && (
            <option value={config.harnessId} disabled>
              {t("defaultHarness.unavailable", { name: config.harnessId })}
            </option>
          )}
          {config.harnesses.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      ) : error === undefined ? (
        <div role="status">{t("defaultHarness.loading")}</div>
      ) : null}
      {error && (
        <div className={css.renameError} role="alert">
          {t(`defaultHarness.${error}`)}
        </div>
      )}
    </Modal>
  );
}
