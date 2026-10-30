/** Safe Markdown anchors and owner-selected bare application links. */
import { Fragment, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { LinkIconMedium } from "../LinkIcon.tsx";
import { useMarkdownDelegate } from "./MarkdownDelegate.tsx";
import css from "./MarkdownText.module.css";

export function sanitizeMarkdownUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case "http:":
      case "https:":
      case "mailto:":
        return url;
      default:
        return "";
    }
  } catch {
    return "";
  }
}

const noLinkChanges = () => () => {};

/** Owner-resolved links still require a browser-safe destination. */
export function MarkdownAnchor({
  href,
  glyph,
  children,
}: {
  readonly href: string;
  readonly glyph: boolean;
  readonly children: ReactNode[];
}): ReactNode {
  const { openExternalLink, resolveLink } = useMarkdownDelegate();
  const destination = () => resolveLink?.(href)?.href;
  const resolvedHref = useSyncExternalStore(
    resolveLink?.subscribe ?? noLinkChanges,
    destination,
    destination,
  );
  const safeHref = sanitizeMarkdownUrl(resolvedHref ?? href);
  if (safeHref === "") return <>{children}</>;
  const external =
    resolvedHref === undefined && ["http:", "https:"].includes(new URL(safeHref).protocol);
  const open =
    resolvedHref !== undefined
      ? () => resolveLink?.(href)?.open()
      : external && openExternalLink !== undefined
        ? () => openExternalLink(safeHref)
        : undefined;
  return (
    <a
      href={safeHref}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={
        open === undefined
          ? undefined
          : (event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              open();
            }
      }
    >
      {glyph && <LinkIconMedium kind="url" href={safeHref} className={css.linkIcon} />}
      {children}
    </a>
  );
}

/** Only text nodes outside existing links reach this component; code stays literal. */
export function MarkdownTextLinks({ value }: { readonly value: string }): ReactNode {
  const { resolveLink } = useMarkdownDelegate();
  const pattern = resolveLink?.autoLinkPattern;
  if (pattern === undefined) return value;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const href = match[0];
    if (!href) continue;
    parts.push(value.slice(offset, match.index));
    parts.push(
      <MarkdownAnchor key={match.index} href={href} glyph={false}>
        {[href]}
      </MarkdownAnchor>,
    );
    offset = match.index + href.length;
  }
  if (offset === 0) return value;
  parts.push(value.slice(offset));
  return <Fragment>{parts}</Fragment>;
}
