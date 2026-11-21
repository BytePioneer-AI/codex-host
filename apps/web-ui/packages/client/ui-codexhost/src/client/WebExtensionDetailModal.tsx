/** Desktop-aligned detail modal for installed (`codexhost` / `dsh`) and marketplace extensions. */
import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  IconCheckCircleFillRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconDownloadOutlineRegular,
  IconRightUpOutlineRegular,
  IconShieldOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Modal,
  Switch,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  resolveLocalizedExtensionText,
  type ExtensionCatalogV2Entry,
  type WebNativeExtensionListItem,
  type WebUiExtension,
  type WebUiExtensionMeta,
} from "@codexhost/shared-contracts";
import { formatWebExtensionError } from "./web-extension-errors.ts";
import {
  backendStateLabel,
  categoryLabelForLocale,
  dshText,
  formatExtensionCount,
  hasNativeCatalogUpdate,
  hasWebBackend,
  isCatalogEntryWebCompatible,
  isNativeToggleBlocked,
  isValidExtensionCount,
  nativeDescription,
  nativeDisplayName,
  parseSafeHttpUrl,
  resolveNativeIconUrl,
  resolveOptionalLocalizedText,
  resolveScreenshotUrls,
  type ExtensionLocale,
  type Translate,
} from "./web-extensions-helpers.ts";
import { ExtensionIcon } from "./WebExtensionCard.tsx";
import { WebExtensionMarkdown } from "./WebExtensionMarkdown.tsx";
import { WebExtensionSettingsForm } from "./WebExtensionSettingsForm.tsx";
import css from "./WebExtensionDetailModal.module.css";

export type DetailModalTarget =
  | {
      readonly kind: "native";
      readonly item?: WebNativeExtensionListItem | undefined;
      readonly catalog?: ExtensionCatalogV2Entry | undefined;
    }
  | { readonly kind: "dsh"; readonly item: WebUiExtension };

export interface WebExtensionDetailModalProps {
  readonly open: boolean;
  readonly target: DetailModalTarget | null;
  readonly dshLoadedIds: readonly string[];
  readonly safeMode: boolean;
  readonly storeError?: string | undefined;
  readonly busy: boolean;
  readonly activeAction: string | null;
  readonly feedback: {
    readonly tone: "success" | "warning" | "danger";
    readonly text: string;
  } | null;
  readonly locale: ExtensionLocale;
  readonly resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string;
  readonly t: Translate;
  readonly onClose: () => void;
  readonly onToggleNative: (item: WebNativeExtensionListItem, enabled: boolean) => void;
  readonly onToggleDsh: (item: WebUiExtension, enabled: boolean) => void;
  readonly onInstallMarket: (entry: ExtensionCatalogV2Entry) => void;
  readonly onUpdateNative: (
    item: WebNativeExtensionListItem,
    entry: ExtensionCatalogV2Entry,
  ) => void;
  readonly onUninstallNative: (item: WebNativeExtensionListItem) => void;
  readonly onUninstallDsh: (item: WebUiExtension) => void;
}

const MARKDOWN_CLASSES = {
  root: css.markdown,
  paragraph: css.mdParagraph,
  h3: css.mdH3,
  h4: css.mdH4,
  h5: css.mdH5,
  list: css.mdList,
  orderedList: css.mdOrderedList,
  code: css.mdCode,
  pre: css.mdPre,
  quote: css.mdQuote,
  link: css.mdLink,
} as const;

export function WebExtensionDetailModal({
  open,
  target,
  dshLoadedIds,
  safeMode,
  storeError,
  busy,
  activeAction,
  feedback,
  locale,
  resolveText,
  t,
  onClose,
  onToggleNative,
  onToggleDsh,
  onInstallMarket,
  onUpdateNative,
  onUninstallNative,
  onUninstallDsh,
}: WebExtensionDetailModalProps): ReactNode {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState<number | null>(null);

  const targetSignature =
    target === null
      ? ""
      : target.kind === "dsh"
        ? `dsh:${target.item.id}`
        : `codexhost:${target.item?.id ?? target.catalog?.id ?? ""}`;

  useEffect(() => {
    setConfirmingUninstall(false);
    setActiveScreenshot(null);
  }, [targetSignature, open]);

  if (!open || target === null) return null;

  const isDsh = target.kind === "dsh";
  const nativeItem = target.kind === "native" ? target.item : undefined;
  const catalogEntry = target.kind === "native" ? target.catalog : undefined;
  const dshItem = target.kind === "dsh" ? target.item : undefined;

  const displayName = isDsh
    ? dshText(target.item, resolveText).title
    : nativeItem
      ? nativeDisplayName(nativeItem, locale, catalogEntry)
      : catalogEntry
        ? resolveLocalizedExtensionText(catalogEntry.name, locale)
        : "";

  const iconUrl = isDsh ? target.item.meta?.icon : resolveNativeIconUrl(nativeItem, catalogEntry);

  const categories = isDsh
    ? undefined
    : (nativeItem?.manifest?.categories ?? catalogEntry?.categories);

  const author = isDsh ? undefined : (nativeItem?.manifest?.author ?? catalogEntry?.author);

  const installedVersion = isDsh
    ? target.item.version
    : (nativeItem?.version ?? nativeItem?.manifest?.version);
  const catalogVersion = catalogEntry?.version;
  const updateAvailable = hasNativeCatalogUpdate(nativeItem, catalogEntry);
  const marketCompatible = catalogEntry ? isCatalogEntryWebCompatible(catalogEntry) : true;

  const repositoryUrl = parseSafeHttpUrl(
    isDsh ? target.item.projectUrl : (nativeItem?.manifest?.repository ?? catalogEntry?.repository),
  );
  const formattedStars = isValidExtensionCount(catalogEntry?.stars)
    ? formatExtensionCount(catalogEntry.stars)
    : null;
  const formattedDownloads = isValidExtensionCount(catalogEntry?.downloads)
    ? formatExtensionCount(catalogEntry.downloads)
    : null;

  const screenshots = isDsh ? [] : resolveScreenshotUrls(nativeItem, catalogEntry);
  const clampedScreenshotIndex =
    activeScreenshot !== null && activeScreenshot < screenshots.length ? activeScreenshot : null;

  const rawDetails = isDsh
    ? dshText(target.item, resolveText).description
    : (resolveOptionalLocalizedText(nativeItem?.manifest?.details, locale) ??
      resolveOptionalLocalizedText(catalogEntry?.details, locale) ??
      (nativeItem ? nativeDescription(nativeItem, locale, catalogEntry) : null) ??
      (catalogEntry ? resolveOptionalLocalizedText(catalogEntry.description, locale) : null));

  const dshEnabled = dshItem ? dshItem.enabledTargets.includes("web") : false;
  const dshLoaded = dshItem ? dshLoadedIds.includes(dshItem.id) : false;

  const statusBadge = (() => {
    if (dshItem) {
      if (dshItem.loadError) return { label: t("extensions.state.error"), tone: "danger" as const };
      if (dshEnabled && !dshLoaded && !safeMode)
        return { label: t("extensions.state.pending"), tone: "warning" as const };
      return dshEnabled
        ? { label: t("extensions.enabled"), tone: "success" as const }
        : { label: t("extensions.disabled"), tone: "neutral" as const };
    }
    if (nativeItem) {
      if (nativeItem.error || nativeItem.manifest === undefined)
        return { label: t("extensions.state.error"), tone: "danger" as const };
      if (nativeItem.backendState === "failed")
        return { label: t("extensions.backend.failed"), tone: "danger" as const };
      if (nativeItem.backendState === "starting")
        return { label: t("extensions.backend.starting"), tone: "info" as const };
      return nativeItem.enabled
        ? { label: t("extensions.enabled"), tone: "success" as const }
        : { label: t("extensions.disabled"), tone: "neutral" as const };
    }
    return null;
  })();

  const attentionMessages: { tone: "warning" | "danger"; text: string }[] = [];
  if (nativeItem?.error) {
    attentionMessages.push({
      tone: "danger",
      text: t("extensions.extensionError", { message: nativeItem.error }),
    });
  } else if (nativeItem && nativeItem.manifest === undefined) {
    attentionMessages.push({
      tone: "danger",
      text: t("extensions.manifestMissing"),
    });
  }
  if (nativeItem?.backendState === "failed") {
    attentionMessages.push({
      tone: "danger",
      text: t("extensions.backendFailedNotice"),
    });
  }
  if (dshItem?.loadError) {
    attentionMessages.push({
      tone: "danger",
      text: t("extensions.extensionError", {
        message: formatWebExtensionError(dshItem.loadError, t),
      }),
    });
  }
  if (dshItem?.meta?.error) {
    attentionMessages.push({
      tone: "warning",
      text: t("extensions.metadataError", { message: dshItem.meta.error }),
    });
  }
  if (dshItem && dshEnabled && !dshLoaded && !safeMode && !dshItem.loadError) {
    attentionMessages.push({
      tone: "warning",
      text: t("extensions.pendingRestart"),
    });
  }
  if (catalogEntry && !marketCompatible) {
    attentionMessages.push({
      tone: "warning",
      text: t("extensions.marketIncompatible"),
    });
  }

  const nativeHasBackend =
    (nativeItem && hasWebBackend(nativeItem)) || Boolean(catalogEntry?.apis.backend !== undefined);
  const nativeHasDesktop =
    Boolean(nativeItem?.manifest?.desktop) || Boolean(catalogEntry?.targets.includes("desktop"));
  const settingsSchema = nativeItem?.manifest?.settingsSchema;

  const isInstalled = nativeItem !== undefined || dshItem !== undefined;
  const nativeToggleBlocked = nativeItem ? isNativeToggleBlocked(nativeItem) : false;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={displayName}
      headless
      className={css.dialog}
    >
      <div
        className={css.surface}
        data-web-extension-detail={targetSignature}
        data-busy={busy ? "true" : undefined}
      >
        <header className={css.header}>
          <div className={css.headerTop}>
            <div className={css.hero}>
              <ExtensionIcon src={iconUrl} categories={categories} size="detail" />
              <div className={css.identity}>
                <div className={css.titleRow}>
                  <h2 className={css.title}>{displayName}</h2>
                  <span className={css.formatBadge} data-format={isDsh ? "dsh" : "codexhost"}>
                    {t(isDsh ? "extensions.format.dsh" : "extensions.format.native")}
                  </span>
                  {catalogEntry && (
                    <span className={css.trustBadge} data-trust-tier={catalogEntry.trustTier}>
                      {catalogEntry.trustTier === "official" && (
                        <IconCheckCircleFillRegular size={11} />
                      )}
                      <span>
                        {t(
                          catalogEntry.trustTier === "official"
                            ? "extensions.trust.official"
                            : "extensions.trust.community",
                        )}
                      </span>
                    </span>
                  )}
                  {statusBadge && (
                    <span className={css.statusBadge} data-tone={statusBadge.tone}>
                      {statusBadge.label}
                    </span>
                  )}
                  {updateAvailable && (
                    <span className={css.updateChip}>{t("extensions.updateAvailable")}</span>
                  )}
                </div>

                <div className={css.metaRow}>
                  {author && (
                    <span className={css.author}>{t("extensions.authorBy", { author })}</span>
                  )}
                  {installedVersion ? (
                    <span className={css.version}>
                      {updateAvailable && catalogVersion
                        ? `v${installedVersion.replace(/^v/u, "")} → v${catalogVersion.replace(/^v/u, "")}`
                        : `v${installedVersion.replace(/^v/u, "")}`}
                    </span>
                  ) : (
                    catalogVersion && (
                      <span className={css.version}>v{catalogVersion.replace(/^v/u, "")}</span>
                    )
                  )}
                  {categories && categories.length > 0 && (
                    <div className={css.categories}>
                      {categories.map((cat) => (
                        <span key={cat} className={css.categoryChip}>
                          {categoryLabelForLocale(cat, locale)}
                        </span>
                      ))}
                    </div>
                  )}
                  {repositoryUrl && (
                    <a
                      href={repositoryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={css.repoLink}
                      title={repositoryUrl}
                    >
                      <span>{t("extensions.githubRepo")}</span>
                      {formattedStars && (
                        <span className={css.repoStars}>· ★ {formattedStars}</span>
                      )}
                      <IconRightUpOutlineRegular size={11} />
                    </a>
                  )}
                  {formattedDownloads && (
                    <span
                      className={css.downloads}
                      title={t("extensions.downloadsLabel", { count: formattedDownloads })}
                    >
                      <IconDownloadOutlineRegular size={12} />
                      <span>{formattedDownloads}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            <button
              type="button"
              className={css.closeButton}
              aria-label={t("extensions.close")}
              title={t("extensions.close")}
              disabled={busy}
              onClick={onClose}
            >
              <IconCloseOutlineRegular size={15} />
            </button>
          </div>

          <div className={css.actionBar}>
            {!isInstalled && catalogEntry && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || !marketCompatible || storeError !== undefined}
                  aria-busy={activeAction === `install:${catalogEntry.id}`}
                  onClick={() => onInstallMarket(catalogEntry)}
                >
                  {t(
                    activeAction === `install:${catalogEntry.id}`
                      ? "extensions.installing"
                      : "extensions.install",
                  )}
                </Button>
                {catalogEntry.trustTier === "community" && (
                  <span className={css.communityNote}>{t("extensions.communityNotice")}</span>
                )}
              </>
            )}

            {nativeItem && (
              <>
                {updateAvailable && catalogEntry && nativeItem.digest && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || storeError !== undefined}
                    aria-busy={activeAction === `update:${nativeItem.id}`}
                    onClick={() => onUpdateNative(nativeItem, catalogEntry)}
                  >
                    {activeAction === `update:${nativeItem.id}`
                      ? t("extensions.updating")
                      : t("extensions.updateToVersion", {
                          version: catalogEntry.version.replace(/^v/u, ""),
                        })}
                  </Button>
                )}
                <Switch
                  label={displayName}
                  checked={nativeItem.enabled}
                  disabled={busy || nativeToggleBlocked || storeError !== undefined}
                  title={nativeToggleBlocked ? t("extensions.toggleBlockedInvalid") : undefined}
                  onChange={(next) => onToggleNative(nativeItem, next)}
                />
              </>
            )}

            {dshItem && (
              <Switch
                label={displayName}
                checked={dshEnabled}
                disabled={busy || storeError !== undefined}
                onChange={(next) => onToggleDsh(dshItem, next)}
              />
            )}

            {isInstalled &&
              (confirmingUninstall ? (
                <div className={css.confirmBox}>
                  <span className={css.confirmText}>{t("extensions.uninstallConfirmPrompt")}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className={css.dangerButton}
                    disabled={busy || storeError !== undefined}
                    onClick={() => {
                      if (nativeItem) onUninstallNative(nativeItem);
                      else if (dshItem) onUninstallDsh(dshItem);
                    }}
                  >
                    {t(
                      activeAction?.startsWith("uninstall:")
                        ? "extensions.uninstalling"
                        : "extensions.uninstallConfirm",
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingUninstall(false)}
                  >
                    {t("extensions.cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className={css.dangerButton}
                  icon={<IconTrashOutlineRegular size={13} />}
                  disabled={busy || storeError !== undefined}
                  onClick={() => setConfirmingUninstall(true)}
                >
                  {t("extensions.remove")}
                </Button>
              ))}
          </div>
        </header>

        <div className={css.body}>
          {feedback && (
            <div
              className={css.inlineNotice}
              data-tone={feedback.tone}
              role={feedback.tone === "success" ? "status" : "alert"}
            >
              {feedback.text}
            </div>
          )}

          {attentionMessages.map((alert, idx) => (
            <div key={idx} className={css.alertBanner} data-tone={alert.tone} role="alert">
              <IconWarningTriangleOutlineRegular size={14} className={css.alertIcon} />
              <span>{alert.text}</span>
            </div>
          ))}

          {/* Declarative settings form for installed codexhost native extensions */}
          {nativeItem && settingsSchema && settingsSchema.length > 0 && (
            <WebExtensionSettingsForm
              extensionId={nativeItem.id}
              enabled={nativeItem.enabled}
              schema={settingsSchema}
              locale={locale}
              t={t}
            />
          )}

          {/* Safe-subset Markdown details or fallback description */}
          {rawDetails && (
            <section className={css.detailsSection}>
              <WebExtensionMarkdown content={rawDetails} classes={MARKDOWN_CLASSES} />
            </section>
          )}

          {/* Screenshots gallery & interactive preview stage */}
          {screenshots.length > 0 && (
            <section className={css.screenshotsSection}>
              <h3 className={css.sectionTitle}>{t("extensions.screenshotsTitle")}</h3>

              {clampedScreenshotIndex !== null &&
                screenshots[clampedScreenshotIndex] !== undefined && (
                  <div className={css.previewStage}>
                    <img
                      src={screenshots[clampedScreenshotIndex]}
                      alt={t("extensions.screenshotAlt", {
                        name: displayName,
                        index: String(clampedScreenshotIndex + 1),
                      })}
                      className={css.previewImage}
                    />
                    <div className={css.previewBar}>
                      <span className={css.previewCount}>
                        {clampedScreenshotIndex + 1} / {screenshots.length}
                      </span>
                      <div className={css.previewControls}>
                        {screenshots.length > 1 && (
                          <>
                            <button
                              type="button"
                              className={css.previewNav}
                              aria-label={t("extensions.previousScreenshot")}
                              title={t("extensions.previousScreenshot")}
                              onClick={() =>
                                setActiveScreenshot(
                                  (clampedScreenshotIndex - 1 + screenshots.length) %
                                    screenshots.length,
                                )
                              }
                            >
                              <IconChevronLeftOutlineRegular size={14} />
                            </button>
                            <button
                              type="button"
                              className={css.previewNav}
                              aria-label={t("extensions.nextScreenshot")}
                              title={t("extensions.nextScreenshot")}
                              onClick={() =>
                                setActiveScreenshot(
                                  (clampedScreenshotIndex + 1) % screenshots.length,
                                )
                              }
                            >
                              <IconChevronRightOutlineRegular size={14} />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className={css.previewClose}
                          onClick={() => setActiveScreenshot(null)}
                        >
                          {t("extensions.closePreview")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

              <div className={css.galleryGrid}>
                {screenshots.map((url, idx) => (
                  <button
                    key={url}
                    type="button"
                    className={css.thumb}
                    aria-pressed={clampedScreenshotIndex === idx}
                    aria-label={t("extensions.screenshotPreviewLabel", {
                      index: String(idx + 1),
                      total: String(screenshots.length),
                    })}
                    onClick={() => setActiveScreenshot(clampedScreenshotIndex === idx ? null : idx)}
                  >
                    <img
                      src={url}
                      alt={t("extensions.screenshotAlt", {
                        name: displayName,
                        index: String(idx + 1),
                      })}
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Permissions, runtime capabilities, and trust notice */}
          <section className={css.trustCard}>
            <div className={css.trustHeader}>
              <IconShieldOutlineRegular size={14} />
              <h3 className={css.sectionTitle}>{t("extensions.trust.title")}</h3>
            </div>
            <p className={css.trustDescription}>
              {isDsh ? t("extensions.trust.dshSummary") : t("extensions.trust.nativeSummary")}
            </p>
            <div className={css.capabilityChips}>
              {!isDsh && (
                <>
                  <span className={css.capabilityChip}>{t("extensions.capability.webUi")}</span>
                  {nativeHasBackend && (
                    <span className={css.capabilityChip}>
                      {nativeItem
                        ? t("extensions.capability.backendWithState", {
                            state: backendStateLabel(nativeItem.backendState, t),
                          })
                        : t("extensions.capability.backend")}
                    </span>
                  )}
                  {nativeHasDesktop && (
                    <span className={css.capabilityChip}>
                      {t("extensions.capability.crossPlatform")}
                    </span>
                  )}
                </>
              )}
              {dshItem && (
                <>
                  <span className={css.capabilityChip}>DSH</span>
                  {dshLoaded && (
                    <span className={css.capabilityChip}>{t("extensions.includedAtStartup")}</span>
                  )}
                </>
              )}
            </div>
            {dshItem && (
              <p className={css.sourceLine}>{t("extensions.source", { source: dshItem.source })}</p>
            )}
            {nativeItem && (
              <p className={css.sourceLine}>
                ID: <code>{nativeItem.id}</code>
                {nativeItem.digest ? (
                  <>
                    {" · "}SHA-256: <code>{nativeItem.digest.slice(0, 12)}…</code>
                  </>
                ) : null}
              </p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
