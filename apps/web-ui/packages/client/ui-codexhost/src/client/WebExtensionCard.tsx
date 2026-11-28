/** Kettu-inspired minimalist extension card / lightweight row and non-blank fading icon. */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
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
  categoryLabelForLocale,
  formatPositiveExtensionCount,
  parseSafeIconUrl,
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
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const safeUrl = parseSafeIconUrl(src);
  const category = categories?.[0] ?? "tools";
  const glyphSize = size === "detail" ? 24 : size === "sidebar" ? 14 : 19;

  useEffect(() => {
    if (!safeUrl || safeUrl === failedSrc || safeUrl === loadedSrc) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setLoadedSrc(safeUrl);
    }
  }, [safeUrl, failedSrc, loadedSrc]);

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

  const shouldTryImage = safeUrl !== null && safeUrl !== failedSrc;
  const isImageLoaded = shouldTryImage && loadedSrc === safeUrl;

  return (
    <span
      className={`${css.icon} ${
        size === "detail" ? css.iconDetail : size === "sidebar" ? css.iconSidebar : css.iconCard
      }`}
      data-icon-kind={isImageLoaded ? "image" : "fallback"}
      data-icon-loaded={isImageLoaded ? "true" : undefined}
      data-icon-category={size === "sidebar" ? undefined : category}
      aria-hidden="true"
    >
      <span className={css.iconFallback} data-hidden={isImageLoaded ? "true" : undefined}>
        {fallbackGlyph}
      </span>
      {shouldTryImage && (
        <img
          ref={imgRef}
          src={safeUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={css.iconImg}
          data-extension-icon
          data-loaded={isImageLoaded ? "true" : undefined}
          onLoad={() => setLoadedSrc(safeUrl)}
          onError={() => setFailedSrc(safeUrl)}
        />
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
  readonly layout?: "featured" | "row" | undefined;
  readonly displayName: string;
  readonly description?: string | null | undefined;
  readonly iconUrl?: string | undefined;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  /** Only shown when the extension is incompatible with the current host (e.g. Desktop-only in Web). */
  readonly incompatiblePlatformLabel?: string | undefined;
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

export function WebExtensionCard({
  cardKey,
  extensionId,
  cardKind,
  layout = "row",
  displayName,
  description,
  iconUrl,
  author,
  version,
  downloads,
  trustTier,
  categories,
  incompatiblePlatformLabel,
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
  const trimmedAuthor = author?.trim() || undefined;
  const formattedVersion = version?.trim()
    ? version.trim().startsWith("v")
      ? version.trim()
      : `v${version.trim()}`
    : undefined;
  const primaryCategory =
    categories && categories.length > 0
      ? categoryLabelForLocale(categories[0]!, contentLocale)
      : undefined;
  const formattedDownloads = formatPositiveExtensionCount(downloads);
  const trimmedDescription = description?.trim() ?? "";

  const metaParts: string[] = [];
  if (primaryCategory) metaParts.push(primaryCategory);
  if (trimmedAuthor) metaParts.push(trimmedAuthor);
  if (formattedVersion) metaParts.push(formattedVersion);
  const downloadsLabel = formattedDownloads
    ? t("extensions.installsCount", { count: formattedDownloads })
    : undefined;
  const metaTitle = [...metaParts, ...(downloadsLabel ? [downloadsLabel] : [])].join(" · ");

  const stopBubble = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
  };

  const titleNode = (
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
          <IconCheckCircleFillRegular size={13} />
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
      {incompatiblePlatformLabel && (
        <span className={css.compatHint} data-platform="desktop">
          {incompatiblePlatformLabel}
        </span>
      )}
    </div>
  );

  const metaLine = (metaParts.length > 0 || formattedDownloads !== null) && (
    <div className={css.metaLine} title={metaTitle}>
      {metaParts.map((part, index) => (
        <span key={`${index}:${part}`} className={css.metaSegment}>
          {part}
        </span>
      ))}
      {formattedDownloads !== null && (
        <span
          className={`${css.metaSegment} ${css.metaDownloads}`}
          aria-label={downloadsLabel}
          title={downloadsLabel}
        >
          <IconDownloadOutlineRegular size={11} aria-hidden="true" />
          <span>{formattedDownloads}</span>
        </span>
      )}
    </div>
  );

  const actionNode = (
    <div className={css.cardAction} onClick={stopBubble} onKeyDown={stopBubble}>
      {secondaryAction}
      {actionControl}
    </div>
  );

  return (
    <article
      className={layout === "featured" ? css.featuredCard : css.rowCard}
      data-web-extension={cardKey}
      data-extension-id={extensionId}
      data-card-kind={cardKind}
      data-layout={layout}
      data-busy={busy ? "true" : undefined}
      data-update-available={update ? "true" : undefined}
      tabIndex={0}
      role="button"
      aria-haspopup="dialog"
      aria-label={t("extensions.openDetailsLabel", { name: displayName })}
      aria-description={incompatiblePlatformLabel}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {layout === "featured" ? (
        <>
          <div className={css.featuredTop}>
            <ExtensionIcon src={iconUrl} categories={categories} size="card" />
            {actionNode}
          </div>
          <div className={css.featuredBody}>
            {titleNode}
            {metaLine}
            {trimmedDescription !== "" && (
              <p className={css.featuredDescription} title={trimmedDescription}>
                {trimmedDescription}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={css.rowIconWrap}>
            <ExtensionIcon src={iconUrl} categories={categories} size="card" />
          </div>
          <div className={css.rowMain}>
            <div className={css.rowTop}>
              <div className={css.rowTextHead}>
                {titleNode}
                {metaLine}
              </div>
              {actionNode}
            </div>
            {trimmedDescription !== "" && (
              <p className={css.rowDescription} title={trimmedDescription}>
                {trimmedDescription}
              </p>
            )}
            {attention !== undefined && (
              <div className={css.cardAttention} data-tone={attention.tone} role="alert">
                <IconWarningTriangleOutlineRegular size={13} className={css.cardAttentionIcon} />
                <span>{attention.text}</span>
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
          </div>
        </>
      )}
    </article>
  );
}

/** Small check icon helper for the "Installed" button on Marketplace items. */
export function InstalledCheckIcon(): ReactNode {
  return <IconCheckOutlineRegular size={13} />;
}
