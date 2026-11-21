/** Desktop-aligned 3-row extension card & category-tinted icon for Installed and Market views. */
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
  formatExtensionCount,
  isValidExtensionCount,
  parseSafeHttpUrl,
  parseSafeIconUrl,
  type ExtensionLocale,
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
  size: "card" | "detail";
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
      className={`${css.icon} ${size === "detail" ? css.iconDetail : css.iconCard}`}
      data-icon-kind={showImage ? "image" : "fallback"}
      data-icon-category={category}
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

export interface WebExtensionCardProps {
  readonly cardKey: string;
  readonly extensionId: string;
  readonly format: "codexhost" | "dsh";
  readonly cardKind: "installed" | "market";
  readonly displayName: string;
  readonly description?: string | null | undefined;
  readonly iconUrl?: string | undefined;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly repository?: string | undefined;
  readonly stars?: number | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  readonly statusDot?:
    { readonly tone: "info" | "warning" | "danger"; readonly label: string } | undefined;
  readonly updateHint?: { readonly label: string; readonly title: string } | undefined;
  readonly attention?: { readonly tone: "warning" | "danger"; readonly text: string } | undefined;
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
  format,
  cardKind,
  displayName,
  description,
  iconUrl,
  author,
  version,
  repository,
  stars,
  downloads,
  trustTier,
  categories,
  statusDot,
  updateHint,
  attention,
  actionControl,
  busy = false,
  contentLocale,
  onOpenDetails,
  t,
}: WebExtensionCardProps): ReactNode {
  const authorVersion = formatAuthorVersion(author, version);
  const repositoryHref = parseSafeHttpUrl(repository);
  const formattedStars = isValidExtensionCount(stars) ? formatExtensionCount(stars) : null;
  const formattedDownloads = isValidExtensionCount(downloads)
    ? formatExtensionCount(downloads)
    : null;
  const categoryLabels = (categories ?? [])
    .slice(0, MAX_CARD_CATEGORIES)
    .map((cat) => categoryLabelForLocale(cat, contentLocale));
  const categoriesText = categoryLabels.join(" · ");
  const trimmedDescription = description?.trim() ?? "";
  const showMeta =
    authorVersion !== "" ||
    updateHint !== undefined ||
    repositoryHref !== null ||
    formattedStars !== null ||
    formattedDownloads !== null ||
    categoriesText !== "";

  const stopBubble = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
  };

  return (
    <article
      className={css.card}
      data-web-extension={cardKey}
      data-extension-id={extensionId}
      data-extension-format={format}
      data-card-kind={cardKind}
      data-busy={busy ? "true" : undefined}
      tabIndex={0}
      role="button"
      aria-haspopup="dialog"
      aria-label={t("extensions.openDetailsLabel", { name: displayName })}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {/* Row 1: 32x32 icon + title (+ optional official shield / error dot) on left; control on right */}
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
          {actionControl}
        </div>
      </div>

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

      {/* Row 3: Borderless muted metadata line matching Desktop card */}
      {showMeta && (
        <div className={css.cardMeta}>
          <div className={css.cardMetaLeft}>
            {(authorVersion !== "" || updateHint !== undefined) && (
              <span
                className={css.authorVersion}
                title={
                  updateHint
                    ? authorVersion
                      ? `${authorVersion} · ${updateHint.title}`
                      : updateHint.title
                    : authorVersion
                }
              >
                {authorVersion !== "" && <span>{authorVersion}</span>}
                {updateHint !== undefined && (
                  <span className={css.updateCue} data-update-available="true">
                    {authorVersion !== "" ? ` · ${updateHint.label}` : updateHint.label}
                  </span>
                )}
              </span>
            )}
            {repositoryHref !== null && (
              <a
                href={repositoryHref}
                target="_blank"
                rel="noopener noreferrer"
                className={css.metaMetricLink}
                title={
                  formattedStars
                    ? `${t("extensions.githubRepo")} · ${formattedStars}`
                    : t("extensions.githubRepo")
                }
                aria-label={
                  formattedStars
                    ? `${t("extensions.githubRepo")} · ${formattedStars}`
                    : t("extensions.githubRepo")
                }
                onClick={stopBubble}
                onKeyDown={stopBubble}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {formattedStars !== null && <span>{formattedStars}</span>}
              </a>
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
