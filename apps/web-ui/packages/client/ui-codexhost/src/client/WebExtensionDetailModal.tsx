/** Unified detail modal for installed Host extensions and Marketplace catalog entries. */
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
  type HostExtensionCatalogEntry,
  type HostExtensionListItem,
} from "@codexhost/shared-contracts";
import {
  backendStateLabel,
  catalogCapabilities,
  categoryLabelForLocale,
  deriveHostCapabilityBadges,
  derivePlatformBadge,
  formatExtensionCount,
  hasHostCatalogUpdate,
  hostDescription,
  hostDisplayName,
  isHostToggleBlocked,
  isValidExtensionCount,
  itemCapabilities,
  itemTargets,
  parseSafeHttpUrl,
  resolveHostIconUrl,
  resolveOptionalLocalizedText,
  resolveScreenshotUrls,
  type ExtensionLocale,
  type HostExtensionValidItem,
  type Translate,
} from "./web-extensions-helpers.ts";
import { ExtensionIcon, WebExtensionPlatformBadge } from "./WebExtensionCard.tsx";
import { WebExtensionMarkdown } from "./WebExtensionMarkdown.tsx";
import { WebExtensionSettingsForm } from "./WebExtensionSettingsForm.tsx";
import css from "./WebExtensionDetailModal.module.css";

export interface DetailModalTarget {
  readonly item?: HostExtensionListItem | undefined;
  readonly catalog?: HostExtensionCatalogEntry | undefined;
}

export interface WebExtensionDetailModalProps {
  readonly open: boolean;
  readonly target: DetailModalTarget | null;
  readonly busy: boolean;
  readonly activeAction: string | null;
  readonly feedback: {
    readonly tone: "success" | "warning" | "danger";
    readonly text: string;
  } | null;
  readonly locale: ExtensionLocale;
  readonly t: Translate;
  readonly onClose: () => void;
  readonly onToggle: (item: HostExtensionListItem, enabled: boolean) => void;
  readonly onInstallMarket: (entry: HostExtensionCatalogEntry) => void;
  readonly onUpdate: (item: HostExtensionValidItem, entry: HostExtensionCatalogEntry) => void;
  readonly onUninstall: (item: HostExtensionListItem) => void;
  readonly onOpenPage: (item: HostExtensionValidItem) => void;
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
  busy,
  activeAction,
  feedback,
  locale,
  t,
  onClose,
  onToggle,
  onInstallMarket,
  onUpdate,
  onUninstall,
  onOpenPage,
}: WebExtensionDetailModalProps): ReactNode {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState<number | null>(null);

  const targetSignature =
    target === null ? "" : `host:${target.item?.id ?? target.catalog?.id ?? ""}`;

  useEffect(() => {
    setConfirmingUninstall(false);
    setActiveScreenshot(null);
  }, [targetSignature, open]);

  if (!open || target === null) return null;

  const item = target.item;
  const catalogEntry = target.catalog;
  const validItem = item?.state === "valid" ? item : undefined;

  const displayName = item
    ? hostDisplayName(item, locale, catalogEntry)
    : catalogEntry
      ? resolveLocalizedExtensionText(catalogEntry.name, locale)
      : "";

  const iconUrl = resolveHostIconUrl(item, catalogEntry);
  const categories = validItem?.manifest.categories ?? catalogEntry?.categories;
  const author = validItem?.manifest.author ?? catalogEntry?.author;

  const installedVersion = validItem?.manifest.version;
  const catalogVersion = catalogEntry?.version;
  const updateAvailable = hasHostCatalogUpdate(item, catalogEntry);

  const repositoryUrl = parseSafeHttpUrl(
    validItem?.manifest.repository ?? catalogEntry?.repository,
  );
  const formattedStars = isValidExtensionCount(catalogEntry?.stars)
    ? formatExtensionCount(catalogEntry.stars)
    : null;
  const formattedDownloads = isValidExtensionCount(catalogEntry?.downloads)
    ? formatExtensionCount(catalogEntry.downloads)
    : null;

  const screenshots = resolveScreenshotUrls(item, catalogEntry);
  const clampedScreenshotIndex =
    activeScreenshot !== null && activeScreenshot < screenshots.length ? activeScreenshot : null;

  const rawDetails =
    resolveOptionalLocalizedText(validItem?.manifest.details, locale) ??
    resolveOptionalLocalizedText(catalogEntry?.details, locale) ??
    (item ? hostDescription(item, locale, catalogEntry) : null) ??
    (catalogEntry ? resolveOptionalLocalizedText(catalogEntry.description, locale) : null);

  const capabilities = validItem
    ? itemCapabilities(validItem)
    : catalogEntry
      ? catalogCapabilities(catalogEntry)
      : null;
  const targets = validItem ? itemTargets(validItem) : (catalogEntry?.targets ?? []);
  const platformBadge = derivePlatformBadge(targets, t);
  const capabilityBadges = deriveHostCapabilityBadges(capabilities, t);

  const statusBadge = (() => {
    if (!item) return null;
    if (item.state !== "valid") {
      return { label: t("extensions.state.error"), tone: "danger" as const };
    }
    if (item.backendState === "failed") {
      return { label: t("extensions.backend.failed"), tone: "danger" as const };
    }
    if (item.desktopConflictWith) {
      return { label: t("extensions.state.conflict"), tone: "warning" as const };
    }
    if (item.backendState === "starting") {
      return { label: t("extensions.backend.starting"), tone: "info" as const };
    }
    return item.enabled
      ? { label: t("extensions.enabled"), tone: "success" as const }
      : { label: t("extensions.disabled"), tone: "neutral" as const };
  })();

  const attentionMessages: { tone: "warning" | "danger"; text: string }[] = [];
  if (item && item.state !== "valid") {
    attentionMessages.push({
      tone: item.state === "incompatible" ? "warning" : "danger",
      text: item.error || t("extensions.manifestMissing"),
    });
  }
  if (validItem?.backendState === "failed") {
    attentionMessages.push({
      tone: "danger",
      text: validItem.backendError || t("extensions.backendFailedNotice"),
    });
  }
  if (validItem?.desktopConflictWith) {
    attentionMessages.push({
      tone: "warning",
      text: t("extensions.desktopConflictNotice", { other: validItem.desktopConflictWith }),
    });
  }

  const settingsSchema = validItem?.manifest.settingsSchema;
  const isInstalled = item !== undefined;
  const toggleBlocked = item ? isHostToggleBlocked(item) : false;
  const canOpenPage = Boolean(validItem && validItem.enabled && validItem.manifest.page);

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

                {platformBadge && (
                  <div>
                    <div className={css.platformRow}>
                      <span>{t("extensions.platform.label")}</span>
                      <WebExtensionPlatformBadge badge={platformBadge} />
                    </div>
                    {platformBadge.kind === "desktop" && (
                      <p className={css.platformNotice}>
                        {t("extensions.platform.desktopOnlyNotice")}
                      </p>
                    )}
                  </div>
                )}

                {capabilityBadges.length > 0 && (
                  <div className={css.capabilityChips}>
                    {capabilityBadges.map((badge) => (
                      <span
                        key={badge.kind}
                        className={css.capabilityChip}
                        data-capability={badge.kind}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>
                )}

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
                  disabled={busy}
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

            {item && (
              <>
                {updateAvailable && catalogEntry && validItem && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    aria-busy={activeAction === `update:${validItem.id}`}
                    onClick={() => onUpdate(validItem, catalogEntry)}
                  >
                    {activeAction === `update:${validItem.id}`
                      ? t("extensions.updating")
                      : t("extensions.updateToVersion", {
                          version: catalogEntry.version.replace(/^v/u, ""),
                        })}
                  </Button>
                )}

                {canOpenPage && validItem && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      onClose();
                      onOpenPage(validItem);
                    }}
                  >
                    {t("extensions.page.open")}
                  </Button>
                )}

                <Switch
                  label={displayName}
                  checked={item.enabled}
                  disabled={busy || toggleBlocked}
                  title={toggleBlocked ? t("extensions.toggleBlockedInvalid") : undefined}
                  onChange={(next) => onToggle(item, next)}
                />
              </>
            )}

            {isInstalled &&
              item &&
              (confirmingUninstall ? (
                <div className={css.confirmBox}>
                  <span className={css.confirmText}>{t("extensions.uninstallConfirmPrompt")}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className={css.dangerButton}
                    disabled={busy}
                    onClick={() => onUninstall(item)}
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
                  disabled={busy}
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

          {/* Declarative settings form for installed Host extensions */}
          {validItem && settingsSchema && settingsSchema.length > 0 && (
            <WebExtensionSettingsForm
              extensionId={validItem.id}
              enabled={validItem.enabled}
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
            <p className={css.trustDescription}>{t("extensions.trust.nativeSummary")}</p>
            <div className={css.capabilityChips}>
              {capabilities?.hasPage && (
                <span className={css.capabilityChip}>{t("extensions.badge.page")}</span>
              )}
              {capabilities?.hasWidget && (
                <span className={css.capabilityChip}>{t("extensions.badge.widget")}</span>
              )}
              {capabilities?.hasWeb && (
                <span className={css.capabilityChip}>{t("extensions.capability.webUi")}</span>
              )}
              {capabilities?.hasDesktop && (
                <span className={css.capabilityChip}>{t("extensions.capability.desktopUi")}</span>
              )}
              {capabilities?.hasBackend && (
                <span className={css.capabilityChip}>
                  {validItem
                    ? t("extensions.capability.backendWithState", {
                        state: backendStateLabel(validItem.backendState, t),
                      })
                    : t("extensions.capability.backend")}
                </span>
              )}
            </div>
            {validItem && (
              <p className={css.sourceLine}>
                ID: <code>{validItem.id}</code>
                {" · "}SHA-256: <code>{validItem.digest.slice(0, 12)}…</code>
              </p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
