import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  harnessIconSources,
  IconChevronDownOutlineRegular,
  IconDataOutlineRegular,
  IconSettingsOutlineRegular,
  Menu,
  Modal,
  RemotePluginIcon,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import css from "./WorkspaceBrowser.module.css";

interface ProjectDefaultHarness {
  harnessId: string | null;
  harnesses: { id: string; name: string }[];
}

function harnessIcon(id: string) {
  return (
    <RemotePluginIcon
      id={id}
      {...harnessIconSources(id)}
      size={16}
      fallback={<IconDataOutlineRegular size={16} />}
    />
  );
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
  const [menuOpen, setMenuOpen] = useState(false);
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

  const inherit = {
    id: "",
    label: t("defaultHarness.inherit"),
    icon: <IconSettingsOutlineRegular size={16} />,
  };
  const items: { id: string; label: string; icon: ReactNode; disabled?: boolean }[] = [
    inherit,
    ...(config?.harnesses.map(({ id, name }) => ({ id, label: name, icon: harnessIcon(id) })) ??
      []),
  ];
  if (config?.harnessId && !items.some(({ id }) => id === config.harnessId)) {
    items.push({
      id: config.harnessId,
      label: t("defaultHarness.unavailable", { name: config.harnessId }),
      icon: harnessIcon(config.harnessId),
      disabled: true,
    });
  }
  const selected = items.find(({ id }) => id === selection) ?? inherit;
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
        <Menu
          open={menuOpen}
          portal
          autoFocus
          listClassName={css.defaultHarnessMenu}
          items={items}
          selectedId={selection}
          onClose={() => setMenuOpen(false)}
          onSelect={(id) => {
            setSelection(id);
            setMenuOpen(false);
          }}
          anchor={
            <button
              type="button"
              className={`${css.renameInput} ${css.defaultHarnessTrigger}`}
              aria-label={t("defaultHarness.select", { name: selected.label })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={saving}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {selected.icon}
              <span>{selected.label}</span>
              <IconChevronDownOutlineRegular size={14} />
            </button>
          }
        />
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
