/** Mutual pairing helpers, result feedback banner, and one-click mesh sync modal. */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, Modal, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  resolveRemotePeerColor,
  type RemotePeerPairingReport,
  type RemotePeerPairingStatus,
  type RemotePeerPairingStep,
  type RemotePeerSummary,
  type RemotePeerTransportKind,
  type WebNetworkAccessUrl,
} from "@codexhost/shared-contracts";
import { accessTokenApi, remotePeersApi } from "./api.ts";
import { BidirectionalIcon, CheckMarkIcon, CloseIcon } from "./RemoteHostIcon.tsx";
import css from "./RemotePeersPanel.module.css";

export type RemotePeersTranslate = PropsLocale<"codexhostImport">["t"];
type Translate = RemotePeersTranslate;

export const TRANSPORT_LABEL: Record<RemotePeerTransportKind, Parameters<Translate>[0]> = {
  relay: "remotePeers.transport.relay",
  tailscale: "remotePeers.transport.tailscale",
  lan: "remotePeers.transport.lan",
  custom: "remotePeers.transport.custom",
};

export const errorMessageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const SHAREABLE_KIND_ORDER = [
  "public",
  "relay",
  "tailscale-funnel",
  "tailscale-https",
  "lan",
] as const;

export type ShareableSelfOriginKind = (typeof SHAREABLE_KIND_ORDER)[number];

export interface ShareableSelfOrigin {
  origin: string;
  kind: ShareableSelfOriginKind;
  hostLabel: string;
}

const SELF_KIND_LABEL: Record<ShareableSelfOriginKind, Parameters<Translate>[0]> = {
  public: "remotePeers.pairing.selfKind.public",
  relay: "remotePeers.pairing.selfKind.relay",
  "tailscale-funnel": "remotePeers.pairing.selfKind.tailscaleFunnel",
  "tailscale-https": "remotePeers.pairing.selfKind.tailscaleHttps",
  lan: "remotePeers.pairing.selfKind.lan",
};

const PAIRING_STATUS_LABEL: Record<RemotePeerPairingStatus, Parameters<Translate>[0]> = {
  added: "remotePeers.pairing.status.added",
  updated: "remotePeers.pairing.status.updated",
  existing: "remotePeers.pairing.status.existing",
  skipped: "remotePeers.pairing.status.skipped",
  failed: "remotePeers.pairing.status.failed",
};

export function extractShareableSelfOrigins(
  urls: readonly WebNetworkAccessUrl[],
): ShareableSelfOrigin[] {
  const seen = new Set<string>();
  const result: ShareableSelfOrigin[] = [];
  for (const kind of SHAREABLE_KIND_ORDER) {
    for (const entry of urls) {
      if (entry.kind !== kind) continue;
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        if (seen.has(parsed.origin)) continue;
        seen.add(parsed.origin);
        result.push({
          origin: parsed.origin,
          kind,
          hostLabel: parsed.host,
        });
      } catch {
        // Ignore malformed entries.
      }
    }
  }
  return result;
}

export function isMeshEligiblePeer(peer: RemotePeerSummary): boolean {
  return peer.enabled && peer.state === "connected" && peer.supportsPeerPairing !== false;
}

export interface SelfShareOriginsState {
  status: "loading" | "ready" | "error";
  origins: ShareableSelfOrigin[];
}

export function useShareableSelfOrigins(): SelfShareOriginsState {
  const [state, setState] = useState<SelfShareOriginsState>({
    status: "loading",
    origins: [],
  });

  useEffect(() => {
    let cancelled = false;
    void accessTokenApi.get().then(
      (data) => {
        if (cancelled) return;
        setState({
          status: "ready",
          origins: extractShareableSelfOrigins(data.networkUrls),
        });
      },
      () => {
        if (cancelled) return;
        setState({ status: "error", origins: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function SelfOriginPicker({
  origins,
  value,
  onChange,
  disabled,
  t,
}: {
  origins: readonly ShareableSelfOrigin[];
  value: string | undefined;
  onChange: (origin: string) => void;
  disabled?: boolean;
  t: Translate;
}): ReactNode {
  const selectId = useId();
  if (origins.length === 0) return null;
  const active = origins.find((item) => item.origin === value) ?? origins[0];
  if (active === undefined) return null;

  if (origins.length === 1) {
    return (
      <div className={css.selfOriginRow}>
        <span className={css.selfOriginLabel}>{t("remotePeers.pairing.selfAddress")}</span>
        <span className={css.selfOriginValue} title={active.origin}>
          <span className={css.selfOriginKind}>{t(SELF_KIND_LABEL[active.kind])}</span>
          <span className={css.selfOriginHost}>{active.hostLabel}</span>
        </span>
      </div>
    );
  }

  return (
    <div className={css.selfOriginPicker}>
      <label htmlFor={selectId} className={css.selfOriginLabel}>
        {t("remotePeers.pairing.selfAddress")}
      </label>
      <select
        id={selectId}
        className={css.selfOriginSelect}
        value={active.origin}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {origins.map((item) => (
          <option key={item.origin} value={item.origin}>
            {`${t(SELF_KIND_LABEL[item.kind])} · ${item.hostLabel}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function formatPairingReason(error: string | undefined, t: Translate): string | undefined {
  if (error === undefined || error === "") return undefined;
  switch (error) {
    case "Remote peer is not connected":
      return t("remotePeers.pairing.reason.notConnected");
    case "Remote peer does not support pairing":
      return t("remotePeers.pairing.reason.unsupported");
    case "This Host has no shareable network address":
    case "This Host has no shareable connection":
      return t("remotePeers.pairing.reason.noSelfShare");
    case "The requested address is not a shareable address of this Host":
      return t("remotePeers.pairing.reason.invalidSelfOrigin");
    case "Could not resolve this Host's shareable connection":
      return t("remotePeers.pairing.reason.selfShareFailed");
    default:
      return error;
  }
}

export function summarizePairingReport(report: RemotePeerPairingReport): {
  total: number;
  ok: number;
  issues: number;
  tone: "success" | "partial" | "error";
} {
  let ok = 0;
  let issues = 0;
  for (const step of report.results) {
    if (step.status === "added" || step.status === "updated" || step.status === "existing") {
      ok += 1;
    } else {
      issues += 1;
    }
  }
  const total = report.results.length;
  const tone = issues === 0 ? "success" : ok === 0 ? "error" : "partial";
  return { total, ok, issues, tone };
}

function PairingStepRow({ step, t }: { step: RemotePeerPairingStep; t: Translate }): ReactNode {
  const introducedLabel =
    step.introducedHost === "local" ? t("remotePeers.pairing.localHost") : step.introducedName;
  const direction = t("remotePeers.pairing.direction", {
    target: step.targetName,
    introduced: introducedLabel,
  });
  const reason = formatPairingReason(step.error, t);

  return (
    <li className={css.pairingStepRow}>
      <div className={css.pairingStepMain}>
        <span className={css.pairingStepDirection} title={direction}>
          {direction}
        </span>
        <span className={css.pairingStatusBadge} data-status={step.status}>
          {t(PAIRING_STATUS_LABEL[step.status])}
        </span>
      </div>
      {reason !== undefined && (
        <p className={css.pairingStepReason} title={reason}>
          {reason}
        </p>
      )}
    </li>
  );
}

export function PairingReportBanner({
  report,
  onDismiss,
  t,
}: {
  report: RemotePeerPairingReport;
  onDismiss: () => void;
  t: Translate;
}): ReactNode {
  const [expanded, setExpanded] = useState(true);
  const summary = useMemo(() => summarizePairingReport(report), [report]);
  if (summary.total === 0) return null;

  const heading =
    summary.tone === "success"
      ? t("remotePeers.pairing.report.allOk", { total: summary.total })
      : summary.tone === "partial"
        ? t("remotePeers.pairing.report.partial", {
            ok: summary.ok,
            issues: summary.issues,
          })
        : t("remotePeers.pairing.report.allFailed", { issues: summary.issues });

  return (
    <section
      className={css.reportBanner}
      data-tone={summary.tone}
      role={summary.tone === "error" ? "alert" : "status"}
    >
      <div className={css.reportBannerHeader}>
        <div className={css.reportBannerTitleRow}>
          {summary.tone === "success" ? (
            <CheckMarkIcon className={css.reportBannerIcon} />
          ) : (
            <span className={css.reportBannerDot} data-tone={summary.tone} aria-hidden="true" />
          )}
          <span className={css.reportBannerTitle}>{heading}</span>
        </div>
        <div className={css.reportBannerActions}>
          <button
            type="button"
            className={css.projectsAction}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {t(
              expanded
                ? "remotePeers.pairing.report.hideDetails"
                : "remotePeers.pairing.report.showDetails",
            )}
          </button>
          <button
            type="button"
            className={css.reportDismissButton}
            aria-label={t("remotePeers.pairing.report.dismiss")}
            onClick={onDismiss}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <ul className={css.pairingStepList}>
          {report.results.map((step, index) => (
            <PairingStepRow
              key={`${step.targetPeerId}-${step.introducedHost}-${String(index)}`}
              step={step}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SyncMeshModal({
  peers,
  onClose,
  onSynced,
  onOpenShareTab,
  t,
}: {
  peers: readonly RemotePeerSummary[];
  onClose: () => void;
  onSynced: () => Promise<void>;
  onOpenShareTab: () => void;
  t: Translate;
}): ReactNode {
  const enabledPeers = useMemo(() => peers.filter((peer) => peer.enabled), [peers]);
  const readyPeers = useMemo(
    () => enabledPeers.filter((peer) => isMeshEligiblePeer(peer)),
    [enabledPeers],
  );
  const selfState = useShareableSelfOrigins();
  const [includeSelf, setIncludeSelf] = useState(false);
  const [selfInitDone, setSelfInitDone] = useState(false);
  const [selectedSelfOrigin, setSelectedSelfOrigin] = useState<string | undefined>(undefined);
  const [includeMesh, setIncludeMesh] = useState(true);
  const [selectedPeerIds, setSelectedPeerIds] = useState<ReadonlySet<string>>(
    () => new Set(readyPeers.map((peer) => peer.peerId)),
  );
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<RemotePeerPairingReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selfInitDone || selfState.status === "loading") return;
    setSelfInitDone(true);
    setIncludeSelf(selfState.origins.length > 0);
  }, [selfInitDone, selfState.origins.length, selfState.status]);

  const hasSelfShare = selfState.origins.length > 0;
  const effectiveSelfOrigin =
    selfState.origins.find((item) => item.origin === selectedSelfOrigin)?.origin ??
    selfState.origins[0]?.origin;
  const selectedReadyIds = readyPeers
    .filter((peer) => selectedPeerIds.has(peer.peerId))
    .map((peer) => peer.peerId);
  const allReadySelected = readyPeers.length > 0 && selectedReadyIds.length === readyPeers.length;
  const effectiveIncludeSelf = includeSelf && hasSelfShare;
  const effectiveIncludeMesh = includeMesh && selectedReadyIds.length >= 2;
  const canSync =
    !syncing && selectedReadyIds.length >= 1 && (effectiveIncludeSelf || effectiveIncludeMesh);

  const togglePeer = (peerId: string): void => {
    setSelectedPeerIds((current) => {
      const next = new Set(current);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  };

  const handleSync = async (): Promise<void> => {
    if (!canSync) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await remotePeersApi.syncMesh({
        peerIds: selectedReadyIds,
        includeSelf: effectiveIncludeSelf,
        includeMesh: effectiveIncludeMesh,
        ...(effectiveIncludeSelf && effectiveSelfOrigin !== undefined
          ? { selfOrigin: effectiveSelfOrigin }
          : {}),
      });
      setReport(result);
      await onSynced();
    } catch (cause) {
      setError(t("remotePeers.actionFailed", { message: errorMessageOf(cause) }));
    } finally {
      setSyncing(false);
    }
  };

  const reportSummary = report !== null ? summarizePairingReport(report) : null;

  return (
    <Modal
      open
      onClose={() => {
        if (!syncing) onClose();
      }}
      title={t("remotePeers.syncMesh.title")}
      closeLabel={t("connectDevices.close")}
      className={css.syncMeshModal}
      footer={
        report !== null ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!canSync}
              aria-busy={syncing}
              onClick={() => void handleSync()}
            >
              {t(syncing ? "remotePeers.syncMesh.syncing" : "remotePeers.syncMesh.syncAgain")}
            </Button>
            <Button variant="primary" size="sm" disabled={syncing} onClick={onClose}>
              {t("remotePeers.syncMesh.done")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={syncing} onClick={onClose}>
              {t("connectDevices.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<BidirectionalIcon size={14} />}
              disabled={!canSync}
              aria-busy={syncing}
              onClick={() => void handleSync()}
            >
              {t(syncing ? "remotePeers.syncMesh.syncing" : "remotePeers.syncMesh.start")}
            </Button>
          </>
        )
      }
    >
      <div className={css.modalForm}>
        <p className={css.syncMeshSubtitle}>{t("remotePeers.syncMesh.description")}</p>
        <div className={css.pairingSection}>
          <div className={css.pairingSwitchRow}>
            <span className={css.switchTitle}>{t("remotePeers.syncMesh.includeSelf")}</span>
            <Switch
              checked={effectiveIncludeSelf}
              disabled={syncing || !hasSelfShare}
              label={t("remotePeers.syncMesh.includeSelf")}
              onChange={setIncludeSelf}
            />
          </div>

          {selfState.status === "loading" && (
            <p className={css.pairingNotice}>{t("remotePeers.pairing.checkingSelf")}</p>
          )}

          {selfState.status !== "loading" && !hasSelfShare && (
            <div className={css.pairingNoticeRow}>
              <span className={css.pairingNotice}>{t("remotePeers.pairing.noSelfShare")}</span>
              <button
                type="button"
                className={css.inlineLinkButton}
                disabled={syncing}
                onClick={() => {
                  onClose();
                  onOpenShareTab();
                }}
              >
                {t("remotePeers.pairing.goToShare")}
              </button>
            </div>
          )}

          {effectiveIncludeSelf && hasSelfShare && (
            <SelfOriginPicker
              origins={selfState.origins}
              value={effectiveSelfOrigin}
              onChange={setSelectedSelfOrigin}
              disabled={syncing}
              t={t}
            />
          )}

          {readyPeers.length >= 2 && (
            <>
              <div className={css.pairingDivider} />
              <div className={css.pairingSwitchRow}>
                <span className={css.switchTitle}>{t("remotePeers.syncMesh.includeMesh")}</span>
                <Switch
                  checked={includeMesh}
                  disabled={syncing || selectedReadyIds.length < 2}
                  label={t("remotePeers.syncMesh.includeMesh")}
                  onChange={setIncludeMesh}
                />
              </div>
            </>
          )}
        </div>

        <div className={css.meshBox}>
          <div className={css.meshBoxHeader}>
            <span className={css.label}>
              {t("remotePeers.syncMesh.selectHosts", {
                selected: selectedReadyIds.length,
                total: readyPeers.length,
              })}
            </span>
            {readyPeers.length >= 2 && (
              <div className={css.meshToolbarActions}>
                <button
                  type="button"
                  className={css.projectsAction}
                  disabled={syncing || allReadySelected}
                  onClick={() => setSelectedPeerIds(new Set(readyPeers.map((peer) => peer.peerId)))}
                >
                  {t("remotePeers.projectsScope.selectAll")}
                </button>
                <button
                  type="button"
                  className={css.projectsAction}
                  disabled={syncing || selectedReadyIds.length === 0}
                  onClick={() => setSelectedPeerIds(new Set())}
                >
                  {t("remotePeers.projectsScope.clear")}
                </button>
              </div>
            )}
          </div>

          {readyPeers.length === 0 ? (
            <p className={css.meshEmptyHint}>{t("remotePeers.syncMesh.noReadyHosts")}</p>
          ) : (
            <div className={css.meshHostList}>
              {enabledPeers.map((peer) => {
                const eligible = isMeshEligiblePeer(peer);
                const checked = eligible && selectedPeerIds.has(peer.peerId);
                const peerColor = resolveRemotePeerColor(peer.hostId, peer.color);
                const unavailableReason =
                  peer.state !== "connected"
                    ? t("remotePeers.syncMesh.hostNotConnected")
                    : peer.supportsPeerPairing === false
                      ? t("remotePeers.syncMesh.hostUnsupported")
                      : undefined;

                return (
                  <label key={peer.peerId} className={css.meshHostRow} data-disabled={!eligible}>
                    <input
                      type="checkbox"
                      className={css.projectCheckbox}
                      checked={checked}
                      disabled={syncing || !eligible}
                      onChange={() => togglePeer(peer.peerId)}
                    />
                    <span
                      className={css.colorDot}
                      data-color={peerColor}
                      data-state={peer.state}
                      aria-hidden="true"
                    />
                    <span className={css.meshHostName}>{peer.name}</span>
                    {unavailableReason !== undefined ? (
                      <span className={css.meshHostStatus}>{unavailableReason}</span>
                    ) : (
                      <span className={css.meshHostMeta}>
                        {peer.pairedBack === true
                          ? t("remotePeers.pairedBack.badge")
                          : t(TRANSPORT_LABEL[peer.transportKind])}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {readyPeers.length > 0 && !canSync && !syncing && (
          <p className={css.hint}>
            {readyPeers.length === 1 && !effectiveIncludeSelf
              ? t("remotePeers.syncMesh.nothingSelected")
              : selectedReadyIds.length === 1 && !effectiveIncludeSelf
                ? t("remotePeers.syncMesh.singleHostHint")
                : t("remotePeers.syncMesh.nothingSelected")}
          </p>
        )}

        {error !== null && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}

        {report !== null && reportSummary !== null && report.results.length > 0 && (
          <div
            className={css.modalReportBox}
            data-tone={reportSummary.tone}
            role={reportSummary.tone === "error" ? "alert" : "status"}
          >
            <div className={css.modalReportHeader}>
              {reportSummary.tone === "success" ? (
                <CheckMarkIcon className={css.reportBannerIcon} />
              ) : (
                <span
                  className={css.reportBannerDot}
                  data-tone={reportSummary.tone}
                  aria-hidden="true"
                />
              )}
              <span className={css.reportBannerTitle}>
                {reportSummary.tone === "success"
                  ? t("remotePeers.pairing.report.allOk", { total: reportSummary.total })
                  : reportSummary.tone === "partial"
                    ? t("remotePeers.pairing.report.partial", {
                        ok: reportSummary.ok,
                        issues: reportSummary.issues,
                      })
                    : t("remotePeers.pairing.report.allFailed", {
                        issues: reportSummary.issues,
                      })}
              </span>
            </div>
            <ul className={css.pairingStepList}>
              {report.results.map((step, index) => (
                <PairingStepRow
                  key={`${step.targetPeerId}-${step.introducedHost}-${String(index)}`}
                  step={step}
                  t={t}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
