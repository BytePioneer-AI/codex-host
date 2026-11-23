/** Add, edit, and remove modal sheets for remote CodexHost peer management. */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Modal, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  RemotePeerAddParams,
  RemotePeerSummary,
  RemotePeerTestParams,
  RemotePeerTestResult,
  RemotePeerTransportKind,
  RemotePeerUpdateParams,
} from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import { dispatchRemotePeersUpdated } from "./remote-peers-events.ts";
import { CheckMarkIcon } from "./RemoteHostIcon.tsx";
import css from "./RemotePeersPanel.module.css";

export type RemotePeersTranslate = PropsLocale<"codexhostImport">["t"];
type AddMode = "link" | "manual";

export const TRANSPORT_LABEL: Record<RemotePeerTransportKind, Parameters<RemotePeersTranslate>[0]> =
  {
    relay: "remotePeers.transport.relay",
    tailscale: "remotePeers.transport.tailscale",
    lan: "remotePeers.transport.lan",
    custom: "remotePeers.transport.custom",
  };

export const errorMessageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function AddPeerModal({
  onClose,
  onAdded,
  t,
}: {
  onClose: () => void;
  onAdded: () => Promise<void>;
  t: RemotePeersTranslate;
}): ReactNode {
  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<RemotePeerTestResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const linkId = useId();
  const originId = useId();
  const tokenId = useId();
  const nameId = useId();
  const formId = useId();

  const formBusy = testing || adding;

  const buildCredentials = ():
    | { ok: true; testParams: RemotePeerTestParams; addParams: RemotePeerAddParams }
    | { ok: false; message: string } => {
    const trimmedName = displayName.trim();
    if (mode === "link") {
      const trimmedUrl = connectionUrl.trim();
      if (!trimmedUrl) {
        return { ok: false, message: t("remotePeers.error.linkRequired") };
      }
      return {
        ok: true,
        testParams: { connectionUrl: trimmedUrl },
        addParams: {
          connectionUrl: trimmedUrl,
          ...(trimmedName ? { name: trimmedName } : {}),
        },
      };
    }
    const trimmedOrigin = origin.trim();
    const trimmedToken = token.trim();
    if (!trimmedOrigin) {
      return { ok: false, message: t("remotePeers.error.originRequired") };
    }
    if (!trimmedToken) {
      return { ok: false, message: t("remotePeers.error.tokenRequired") };
    }
    return {
      ok: true,
      testParams: { origin: trimmedOrigin, token: trimmedToken },
      addParams: {
        origin: trimmedOrigin,
        token: trimmedToken,
        ...(trimmedName ? { name: trimmedName } : {}),
      },
    };
  };

  const handleTest = async (): Promise<void> => {
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      setTestResult(null);
      return;
    }
    setTesting(true);
    setFormError(null);
    setTestResult(null);
    try {
      const result = await remotePeersApi.test(built.testParams);
      setTestResult(result);
    } catch (cause) {
      setTestResult({ ok: false, error: errorMessageOf(cause) });
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await remotePeersApi.add(built.addParams);
      dispatchRemotePeersUpdated();
      await onAdded();
      onClose();
    } catch (cause) {
      setFormError(t("remotePeers.actionFailed", { message: errorMessageOf(cause) }));
    } finally {
      setAdding(false);
    }
  };

  const testSummary =
    testResult !== null && testResult.ok
      ? [
          t("remotePeers.testSuccess"),
          testResult.latencyMs !== undefined
            ? t("remotePeers.latencyMs", { ms: testResult.latencyMs })
            : undefined,
          testResult.projectCount !== undefined
            ? t("remotePeers.projectCount", { count: testResult.projectCount })
            : undefined,
          testResult.transportKind !== undefined
            ? t(TRANSPORT_LABEL[testResult.transportKind])
            : undefined,
          testResult.hostname,
        ]
          .filter(Boolean)
          .join(" · ")
      : testResult !== null
        ? [t("remotePeers.testFailed"), testResult.error].filter(Boolean).join(" · ")
        : null;

  return (
    <Modal
      open
      onClose={() => {
        if (!formBusy) onClose();
      }}
      title={t("remotePeers.addTitle")}
      closeLabel={t("connectDevices.close")}
      className={css.addModal}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={formBusy}
            aria-busy={testing}
            onClick={() => void handleTest()}
          >
            {t(testing ? "remotePeers.testing" : "remotePeers.testConnection")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={formId}
            disabled={formBusy}
            aria-busy={adding}
          >
            {t(adding ? "remotePeers.adding" : "remotePeers.add")}
          </Button>
        </>
      }
    >
      <form id={formId} className={css.modalForm} onSubmit={(event) => void handleAdd(event)}>
        {mode === "link" ? (
          <div className={css.field}>
            <div className={css.fieldHead}>
              <label htmlFor={linkId} className={css.label}>
                {t("remotePeers.field.link")}
              </label>
              <button
                type="button"
                className={css.modeToggle}
                disabled={formBusy}
                onClick={() => {
                  setMode("manual");
                  setFormError(null);
                  setTestResult(null);
                }}
              >
                {t("remotePeers.switchToManual")}
              </button>
            </div>
            <input
              id={linkId}
              className={css.input}
              value={connectionUrl}
              disabled={formBusy}
              placeholder={t("remotePeers.placeholder.link")}
              autoComplete="off"
              spellCheck={false}
              data-modal-autofocus
              onChange={(event) => {
                setConnectionUrl(event.target.value);
                setFormError(null);
                setTestResult(null);
              }}
            />
          </div>
        ) : (
          <>
            <div className={css.field}>
              <div className={css.fieldHead}>
                <label htmlFor={originId} className={css.label}>
                  {t("remotePeers.field.origin")}
                </label>
                <button
                  type="button"
                  className={css.modeToggle}
                  disabled={formBusy}
                  onClick={() => {
                    setMode("link");
                    setFormError(null);
                    setTestResult(null);
                  }}
                >
                  {t("remotePeers.switchToLink")}
                </button>
              </div>
              <input
                id={originId}
                className={css.input}
                value={origin}
                disabled={formBusy}
                placeholder={t("remotePeers.placeholder.origin")}
                autoComplete="off"
                spellCheck={false}
                data-modal-autofocus
                onChange={(event) => {
                  setOrigin(event.target.value);
                  setFormError(null);
                  setTestResult(null);
                }}
              />
            </div>
            <div className={css.field}>
              <label htmlFor={tokenId} className={css.label}>
                {t("remotePeers.field.token")}
              </label>
              <input
                id={tokenId}
                type="password"
                className={css.input}
                value={token}
                disabled={formBusy}
                placeholder={t("remotePeers.placeholder.token")}
                autoComplete="new-password"
                onChange={(event) => {
                  setToken(event.target.value);
                  setFormError(null);
                  setTestResult(null);
                }}
              />
            </div>
          </>
        )}

        <div className={css.field}>
          <label htmlFor={nameId} className={css.label}>
            {t("remotePeers.field.nameOptional")}
          </label>
          <input
            id={nameId}
            className={css.input}
            value={displayName}
            disabled={formBusy}
            maxLength={120}
            placeholder={t("remotePeers.placeholder.name")}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        {testResult !== null && testSummary !== null && (
          <div
            className={css.testInline}
            data-ok={testResult.ok}
            role={testResult.ok ? "status" : "alert"}
          >
            {testResult.ok ? (
              <CheckMarkIcon className={css.testCheckIcon} />
            ) : (
              <span className={css.testDot} aria-hidden="true" />
            )}
            <span className={css.testInlineText} title={testSummary}>
              {testSummary}
            </span>
          </div>
        )}

        {formError !== null && (
          <p className={css.error} role="alert">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function EditPeerModal({
  peer,
  onClose,
  onSaved,
  t,
}: {
  peer: RemotePeerSummary;
  onClose: () => void;
  onSaved: (updated: RemotePeerSummary) => void;
  t: RemotePeersTranslate;
}): ReactNode {
  const [name, setName] = useState(peer.name);
  const [enabled, setEnabled] = useState(peer.enabled);
  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState(peer.origin);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const linkId = useId();
  const originId = useId();
  const tokenId = useId();
  const editFormId = useId();

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("remotePeers.error.nameRequired"));
      return;
    }
    const payload: RemotePeerUpdateParams = {
      peerId: peer.peerId,
      name: trimmedName,
      enabled,
    };
    if (mode === "link") {
      const trimmedUrl = connectionUrl.trim();
      if (trimmedUrl) payload.connectionUrl = trimmedUrl;
    } else {
      const trimmedOrigin = origin.trim();
      const trimmedToken = token.trim();
      if (trimmedOrigin && trimmedOrigin !== peer.origin) payload.origin = trimmedOrigin;
      if (trimmedToken) payload.token = trimmedToken;
    }
    setSaving(true);
    setError(null);
    try {
      const { peer: updated } = await remotePeersApi.update(payload);
      dispatchRemotePeersUpdated();
      onSaved(updated);
    } catch (cause) {
      setError(t("remotePeers.actionFailed", { message: errorMessageOf(cause) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={t("remotePeers.editTitle", { name: peer.name })}
      closeLabel={t("connectDevices.close")}
      className={css.addModal}
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={editFormId}
            disabled={saving}
            aria-busy={saving}
          >
            {t(saving ? "remotePeers.saving" : "remotePeers.save")}
          </Button>
        </>
      }
    >
      <form id={editFormId} className={css.modalForm} onSubmit={(event) => void submit(event)}>
        <div className={css.field}>
          <label htmlFor={nameId} className={css.label}>
            {t("remotePeers.field.name")}
          </label>
          <input
            id={nameId}
            className={css.input}
            value={name}
            disabled={saving}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            data-modal-autofocus
          />
        </div>
        <div className={css.switchRow}>
          <div className={css.switchText}>
            <span className={css.switchTitle}>{t("remotePeers.field.enabled")}</span>
            <span className={css.hint}>{t("remotePeers.field.enabledHint")}</span>
          </div>
          <Switch
            checked={enabled}
            disabled={saving}
            label={t("remotePeers.field.enabled")}
            onChange={setEnabled}
          />
        </div>
        <div className={css.credentialsBox}>
          <div className={css.fieldHead}>
            <span className={css.label}>{t("remotePeers.editCredentialsTitle")}</span>
            <button
              type="button"
              className={css.modeToggle}
              disabled={saving}
              onClick={() => {
                setMode((prev) => (prev === "link" ? "manual" : "link"));
                setError(null);
              }}
            >
              {t(mode === "link" ? "remotePeers.switchToManual" : "remotePeers.switchToLink")}
            </button>
          </div>
          <p className={css.hint}>{t("remotePeers.editCredentialsHint")}</p>
          {mode === "link" ? (
            <div className={css.field}>
              <label htmlFor={linkId} className={css.label}>
                {t("remotePeers.field.linkOptional")}
              </label>
              <input
                id={linkId}
                className={css.input}
                value={connectionUrl}
                disabled={saving}
                placeholder={t("remotePeers.placeholder.link")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConnectionUrl(event.target.value)}
              />
            </div>
          ) : (
            <>
              <div className={css.field}>
                <label htmlFor={originId} className={css.label}>
                  {t("remotePeers.field.origin")}
                </label>
                <input
                  id={originId}
                  className={css.input}
                  value={origin}
                  disabled={saving}
                  placeholder={t("remotePeers.placeholder.origin")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </div>
              <div className={css.field}>
                <label htmlFor={tokenId} className={css.label}>
                  {t("remotePeers.field.tokenOptional")}
                </label>
                <input
                  id={tokenId}
                  type="password"
                  className={css.input}
                  value={token}
                  disabled={saving}
                  placeholder={t("remotePeers.placeholder.tokenKeep")}
                  autoComplete="new-password"
                  onChange={(event) => setToken(event.target.value)}
                />
              </div>
            </>
          )}
        </div>
        {error !== null && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function RemovePeerModal({
  peer,
  busy,
  error,
  onClose,
  onConfirm,
  t,
}: {
  peer: RemotePeerSummary;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  t: RemotePeersTranslate;
}): ReactNode {
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("remotePeers.removeTitle", { name: peer.name })}
      description={t("remotePeers.removeDescription", { origin: peer.origin })}
      closeLabel={t("connectDevices.close")}
      className={css.confirm}
      footer={
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className={css.dangerConfirm}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {t(busy ? "remotePeers.removing" : "remotePeers.removeConfirm")}
          </Button>
        </>
      }
    >
      {error !== null && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
