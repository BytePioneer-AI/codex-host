/** Desktop-aligned minimalist extension card & category-tinted icon for Installed and Market views. */
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  IconCheckCircleFillRegular,
  IconCheckOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDataOutlineRegular,
  IconDownloadOutlineRegular,
  IconLinkOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconPlanOutlineRegular,
  IconSparkleRegular,
  IconWarningTriangleOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  DesktopExtensionCategory,
  DesktopExtensionTrustTier,
} from "@codexhost/shared-contracts";
import {
  MAX_CARD_CATEGORIES,
  categoryLabelForLocale,
  formatPositiveExtensionCount,
  parseSafeIconUrl,
  type ExtensionCapabilityBadge,
  type ExtensionLocale,
  type ExtensionPlatformBadge,
  type Translate,
} from "./web-extensions-helpers.ts";
import css from "./WebExtensionsSection.module.css";

export function ExtensionIcon({
  src,
  categories,
  size,
}: {
  src?: string | undefined;
  categories?: readonly DesktopExtensionCategory[] | undefined;
  size: "card" | "detail" | "sidebar";
}): ReactNode {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeUrl = parseSafeIconUrl(src);
  const category = categories?.[0] ?? "tools";
  const glyphSize = size === "detail" ? 22 : 16;

  const fallbackGlyph = (() => {
    switch (category) {
      case "appearance":
        return <IconPersonalizationOutlineRegular size={glyphSize} />;
      case "interface":
        return <IconPlanOutlineRegular size={glyphSize} />;
      case "workflow":
        return <IconSparkleRegular size={glyphSize} />;
      case "analytics":
        return <IconDataOutlineRegular size={glyphSize} />;
      case "integrations":
        return <IconLinkOutlineRegular size={glyphSize} />;
      default:
        return <IconCordisPluginOutlineRegular size={glyphSize} />;
    }
  })();

  const showImage = safeUrl !== null && safeUrl !== failedSrc;

  return (
    <span
      className={`${css.icon} ${size === "detail" ? css.iconDetail : size === "sidebar" ? css.iconSidebar : css.iconCard}`}
      data-icon-kind={showImage ? "image" : "fallback"}
      data-icon-category={size === "sidebar" ? undefined : category}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={safeUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={css.iconImg}
          data-extension-icon
          onError={() => setFailedSrc(safeUrl)}
        />
      ) : (
        fallbackGlyph
      )}
    </span>
  );
}

export function WebExtensionPlatformBadge({ badge }: { badge: ExtensionPlatformBadge }) {
  return (
    <span className={css.capBadge} data-platform={badge.kind}>
      {badge.label}
    </span>
  );
}

export interface WebExtensionCardProps {
  readonly cardKey: string;
  readonly extensionId: string;
  readonly cardKind: "installed" | "market";
  readonly displayName: string;
  readonly description?: string | null | undefined;
  readonly iconUrl?: string | undefined;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  readonly platformBadge: ExtensionPlatformBadge | null;
  readonly capabilityBadges?: readonly ExtensionCapabilityBadge[] | undefined;
  readonly statusDot?:
    { readonly tone: "info" | "warning" | "danger"; readonly label: string } | undefined;
  readonly update?: { readonly label: string; readonly action: ReactNode } | undefined;
  readonly attention?: { readonly tone: "warning" | "danger"; readonly text: string } | undefined;
  readonly secondaryAction?: ReactNode;
  readonly actionControl: ReactNode;
  readonly busy?: boolean | undefined;
  readonly contentLocale: ExtensionLocale;
  readonly onOpenDetails: () => void;
  readonly t: Translate;
}

function formatAuthorVersion(author: string | undefined, version: string | undefined): string {
  const parts: string[] = [];
  const trimmedAuthor = author?.trim();
  const trimmedVersion = version?.trim();
  if (trimmedAuthor) parts.push(trimmedAuthor);
  if (trimmedVersion)
    parts.push(trimmedVersion.startsWith("v") ? trimmedVersion : `v${trimmedVersion}`);
  return parts.join(" · ");
}

export function WebExtensionCard({
  cardKey,
  extensionId,
  cardKind,
  displayName,
  description,
  iconUrl,
  author,
  version,
  downloads,
  trustTier,
  categories,
  platformBadge,
  capabilityBadges = [],
  statusDot,
  update,
  attention,
  secondaryAction,
  actionControl,
  busy = false,
  contentLocale,
  onOpenDetails,
  t,
}: WebExtensionCardProps): ReactNode {
  const authorVersion = formatAuthorVersion(author, version);
  const formattedDownloads = formatPositiveExtensionCount(downloads);
  const categoryLabels = (categories ?? [])
    .slice(0, MAX_CARD_CATEGORIES)
    .map((cat) => categoryLabelForLocale(cat, contentLocale));
  const categoriesText = categoryLabels.join(" · ");
  const trimmedDescription = description?.trim() ?? "";
  const showMeta = authorVersion !== "" || formattedDownloads !== null || categoriesText !== "";

  const stopBubble = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
  };

  return (
    <article
      className={css.card}
      data-web-extension={cardKey}
      data-extension-id={extensionId}
      data-card-kind={cardKind}
      data-busy={busy ? "true" : undefined}
      data-update-available={update ? "true" : undefined}
      tabIndex={0}
      role="button"
      aria-haspopup="dialog"
      aria-label={t("extensions.openDetailsLabel", { name: displayName })}
      aria-description={platformBadge?.label}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {/* Row 1: 32x32 icon + title (+ optional official shield / error dot) on left; controls on right */}
      <div className={css.cardTop}>
        <div className={css.cardIdentity}>
          <ExtensionIcon src={iconUrl} categories={categories} size="card" />
          <div className={css.cardTitleGroup}>
            <h3 className={css.cardTitle} title={displayName}>
              {displayName}
            </h3>
            {trustTier === "official" && (
              <span
                className={css.verifiedIcon}
                role="img"
                aria-label={t("extensions.trust.official")}
                title={t("extensions.trust.official")}
              >
                <IconCheckCircleFillRegular size={14} />
              </span>
            )}
            {statusDot !== undefined && (
              <span
                className={css.statusDot}
                data-tone={statusDot.tone}
                role="img"
                aria-label={statusDot.label}
                title={statusDot.label}
              />
            )}
          </div>
        </div>
        <div className={css.cardAction} onClick={stopBubble} onKeyDown={stopBubble}>
          {secondaryAction}
          {actionControl}
        </div>
      </div>

      {/* Platform and capability badges */}
      {(platformBadge || capabilityBadges.length > 0) && (
        <div className={css.cardCapabilities}>
          {platformBadge && <WebExtensionPlatformBadge badge={platformBadge} />}
          {capabilityBadges.map((badge) => (
            <span key={badge.kind} className={css.capBadge} data-capability={badge.kind}>
              {badge.label}
            </span>
          ))}
        </div>
      )}

      {/* Row 2: 2-line muted description + compact error callout only when abnormal */}
      {(trimmedDescription !== "" || attention !== undefined) && (
        <div className={css.cardBody}>
          {trimmedDescription !== "" && (
            <p className={css.cardDescription} title={trimmedDescription}>
              {trimmedDescription}
            </p>
          )}
          {attention !== undefined && (
            <div className={css.cardAttention} data-tone={attention.tone} role="alert">
              <IconWarningTriangleOutlineRegular size={13} className={css.cardAttentionIcon} />
              <span>{attention.text}</span>
            </div>
          )}
        </div>
      )}

      {update && (
        <div className={css.cardUpdate} data-update-available="true">
          <span className={css.cardUpdateLabel}>{update.label}</span>
          <div className={css.cardUpdateAction} onClick={stopBubble} onKeyDown={stopBubble}>
            {update.action}
          </div>
        </div>
      )}

      {/* Borderless muted metadata line */}
      {showMeta && (
        <div className={css.cardMeta}>
          <div className={css.cardMetaLeft}>
            {authorVersion !== "" && (
              <span className={css.authorVersion} title={authorVersion}>
                {authorVersion}
              </span>
            )}
            {formattedDownloads !== null && (
              <span
                className={css.metaMetric}
                title={t("extensions.downloadsLabel", { count: formattedDownloads })}
                aria-label={t("extensions.downloadsLabel", { count: formattedDownloads })}
              >
                <IconDownloadOutlineRegular size={11} />
                <span>{formattedDownloads}</span>
              </span>
            )}
          </div>
          {categoriesText !== "" && (
            <span className={css.cardCategoriesText} title={categoriesText}>
              {categoriesText}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** Small check icon helper for the "Installed" button on Marketplace cards. */
export function InstalledCheckIcon(): ReactNode {
  return <IconCheckOutlineRegular size={12} />;
}
