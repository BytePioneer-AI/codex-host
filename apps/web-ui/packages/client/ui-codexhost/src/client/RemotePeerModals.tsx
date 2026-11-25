/** Add, edit, and remove modal sheets for remote CodexHost peer management. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button, Modal, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  REMOTE_PEER_COLORS,
  remotePeerWorkspaceId,
  resolveRemotePeerColor,
  type RemotePeerAddParams,
  type RemotePeerColor,
  type RemotePeerSummary,
  type RemotePeerTestParams,
  type RemotePeerTestResult,
  type RemotePeerTransportKind,
  type RemotePeerUpdateParams,
} from "@codexhost/shared-contracts";
import { remotePeersApi } from "./api.ts";
import { PeerColorPicker } from "./PeerColorPicker.tsx";
import {
  dispatchRemotePeersUpdated,
  persistAndDispatchHostScopeWorkspaceSelection,
} from "./remote-peers-events.ts";
import { CheckMarkIcon } from "./RemoteHostIcon.tsx";
import css from "./RemotePeersPanel.module.css";

const AUTO_PROBE_DEBOUNCE_MS = 400;

function hasCompleteConnectionLink(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const queryToken = url.searchParams.get("token")?.trim();
    if (queryToken) return true;
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (!hash) return false;
    const hashToken = new URLSearchParams(hash).get("token")?.trim();
    return Boolean(hashToken);
  } catch {
    return false;
  }
}

function ChevronDownIcon({ className, expanded }: { className?: string; expanded: boolean }) {
  return (
    <span className={className} data-expanded={expanded} aria-hidden="true">
      <svg
        width={13}
        height={13}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.25 6.25L8 10l3.75-3.75" />
      </svg>
    </span>
  );
}

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
  suggestedColor,
  onClose,
  onAdded,
  t,
}: {
  suggestedColor?: RemotePeerColor;
  onClose: () => void;
  onAdded: () => Promise<void>;
  t: RemotePeersTranslate;
}): ReactNode {
  const [mode, setMode] = useState<AddMode>("link");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState<RemotePeerColor>(suggestedColor ?? REMOTE_PEER_COLORS[0]);
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<RemotePeerTestResult | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<ReadonlySet<string> | null>(null);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const testSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const lastAutoProbedLinkRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testSeqRef.current += 1;
    };
  }, []);

  const linkId = useId();
  const originId = useId();
  const tokenId = useId();
  const nameId = useId();
  const formId = useId();
  const projectsListId = useId();

  const resetProbeState = useCallback((): void => {
    testSeqRef.current += 1;
    lastAutoProbedLinkRef.current = null;
    setTesting(false);
    setFormError(null);
    setTestResult(null);
    setSelectedProjectIds(null);
    setProjectsExpanded(false);
  }, []);

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
          color,
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
        color,
      },
    };
  };

  const runProbe = useCallback(async (params: RemotePeerTestParams): Promise<void> => {
    const seq = ++testSeqRef.current;
    setTesting(true);
    setFormError(null);
    setTestResult(null);
    setSelectedProjectIds(null);
    setProjectsExpanded(false);
    try {
      const result = await remotePeersApi.test(params);
      if (seq !== testSeqRef.current || !mountedRef.current) return;
      setTestResult(result);
      if (result.ok && result.projects !== undefined && result.projects.length > 0) {
        setSelectedProjectIds(new Set(result.projects.map((project) => project.id)));
      }
    } catch (cause) {
      if (seq !== testSeqRef.current || !mountedRef.current) return;
      setTestResult({ ok: false, error: errorMessageOf(cause) });
    } finally {
      if (seq === testSeqRef.current && mountedRef.current) {
        setTesting(false);
      }
    }
  }, []);

  useEffect(() => {
    if (mode !== "link" || adding) return;
    const trimmed = connectionUrl.trim();
    if (!hasCompleteConnectionLink(trimmed) || lastAutoProbedLinkRef.current === trimmed) return;
    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      lastAutoProbedLinkRef.current = trimmed;
      void runProbe({ connectionUrl: trimmed });
    }, AUTO_PROBE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [adding, connectionUrl, mode, runProbe]);

  const handleTest = async (): Promise<void> => {
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      setTestResult(null);
      setSelectedProjectIds(null);
      setProjectsExpanded(false);
      return;
    }
    if (mode === "link") {
      lastAutoProbedLinkRef.current = connectionUrl.trim();
    }
    await runProbe(built.testParams);
  };

  const probedProjects = testResult !== null && testResult.ok ? (testResult.projects ?? []) : [];
  const selectedCount =
    selectedProjectIds === null
      ? probedProjects.length
      : probedProjects.reduce(
          (count, project) => count + (selectedProjectIds.has(project.id) ? 1 : 0),
          0,
        );
  const allProjectsSelected = selectedCount === probedProjects.length;

  const toggleProjectSelection = (projectId: string): void => {
    setSelectedProjectIds((current) => {
      const next = new Set(current ?? probedProjects.map((project) => project.id));
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const handleAdd = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const built = buildCredentials();
    if (!built.ok) {
      setFormError(built.message);
      return;
    }
    testSeqRef.current += 1;
    setTesting(false);
    setAdding(true);
    setFormError(null);
    try {
      const { peer } = await remotePeersApi.add(built.addParams);
      if (
        probedProjects.length > 0 &&
        selectedProjectIds !== null &&
        selectedCount < probedProjects.length
      ) {
        const workspaceIds = probedProjects
          .filter((project) => selectedProjectIds.has(project.id))
          .map((project) => remotePeerWorkspaceId(peer.hostId, project.id));
        persistAndDispatchHostScopeWorkspaceSelection(peer.hostId, workspaceIds);
      }
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
        if (!adding) onClose();
      }}
      title={t("remotePeers.addTitle")}
      closeLabel={t("connectDevices.close")}
      className={css.addModal}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={adding || testing}
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
            disabled={adding}
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
                disabled={adding}
                onClick={() => {
                  setMode("manual");
                  resetProbeState();
                }}
              >
                {t("remotePeers.switchToManual")}
              </button>
            </div>
            <input
              id={linkId}
              className={css.input}
              value={connectionUrl}
              disabled={adding}
              placeholder={t("remotePeers.placeholder.link")}
              autoComplete="off"
              spellCheck={false}
              data-modal-autofocus
              onChange={(event) => {
                setConnectionUrl(event.target.value);
                resetProbeState();
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
                  disabled={adding}
                  onClick={() => {
                    setMode("link");
                    resetProbeState();
                  }}
                >
                  {t("remotePeers.switchToLink")}
                </button>
              </div>
              <input
                id={originId}
                className={css.input}
                value={origin}
                disabled={adding}
                placeholder={t("remotePeers.placeholder.origin")}
                autoComplete="off"
                spellCheck={false}
                data-modal-autofocus
                onChange={(event) => {
                  setOrigin(event.target.value);
                  resetProbeState();
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
                disabled={adding}
                placeholder={t("remotePeers.placeholder.token")}
                autoComplete="new-password"
                onChange={(event) => {
                  setToken(event.target.value);
                  resetProbeState();
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
            disabled={adding}
            maxLength={120}
            placeholder={t("remotePeers.placeholder.name")}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        <div className={css.field}>
          <span className={css.label}>{t("remotePeers.field.color")}</span>
          <PeerColorPicker value={color} onChange={setColor} disabled={adding} t={t} />
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

        {probedProjects.length > 0 && (
          <div className={css.projectsSection}>
            <button
              type="button"
              className={css.projectsHeader}
              aria-expanded={projectsExpanded}
              aria-controls={projectsListId}
              disabled={adding}
              onClick={() => setProjectsExpanded((prev) => !prev)}
            >
              <span className={css.projectsHeaderLabel}>
                {allProjectsSelected
                  ? t("remotePeers.projectsScope.all", { count: probedProjects.length })
                  : t("remotePeers.projectsScope.selected", {
                      selected: selectedCount,
                      total: probedProjects.length,
                    })}
              </span>
              <ChevronDownIcon className={css.projectsChevron} expanded={projectsExpanded} />
            </button>
            {projectsExpanded && (
              <div id={projectsListId} className={css.projectsBody}>
                <div className={css.projectsToolbar}>
                  <button
                    type="button"
                    className={css.projectsAction}
                    disabled={adding || allProjectsSelected}
                    onClick={() =>
                      setSelectedProjectIds(new Set(probedProjects.map((project) => project.id)))
                    }
                  >
                    {t("remotePeers.projectsScope.selectAll")}
                  </button>
                  <button
                    type="button"
                    className={css.projectsAction}
                    disabled={adding || selectedCount === 0}
                    onClick={() => setSelectedProjectIds(new Set())}
                  >
                    {t("remotePeers.projectsScope.clear")}
                  </button>
                </div>
                <div className={css.projectsList}>
                  {probedProjects.map((project) => {
                    const checked =
                      selectedProjectIds === null || selectedProjectIds.has(project.id);
                    return (
                      <label key={project.id} className={css.projectRow} title={project.path}>
                        <input
                          type="checkbox"
                          className={css.projectCheckbox}
                          checked={checked}
                          disabled={adding}
                          onChange={() => toggleProjectSelection(project.id)}
                        />
                        <span className={css.projectText}>
                          <span className={css.projectName}>{project.name}</span>
                          <span className={css.projectPath}>{project.path}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
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
  eventSource,
  t,
}: {
  peer: RemotePeerSummary;
  onClose: () => void;
  onSaved: (updated: RemotePeerSummary) => void;
  eventSource?: unknown;
  t: RemotePeersTranslate;
}): ReactNode {
  const [name, setName] = useState(peer.name);
  const [color, setColor] = useState<RemotePeerColor>(() =>
    resolveRemotePeerColor(peer.hostId, peer.color),
  );
  const [colorTouched, setColorTouched] = useState(false);
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
      ...(colorTouched ? { color } : {}),
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
      dispatchRemotePeersUpdated(eventSource === undefined ? undefined : { source: eventSource });
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
        <div className={css.field}>
          <span className={css.label}>{t("remotePeers.field.color")}</span>
          <PeerColorPicker
            value={color}
            onChange={(next) => {
              setColor(next);
              setColorTouched(true);
            }}
            disabled={saving}
            t={t}
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
