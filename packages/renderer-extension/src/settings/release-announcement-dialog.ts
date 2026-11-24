import type { ReleaseAnnouncement, ReleaseAnnouncementContent } from "@codexhost/shared-contracts";

import { createRendererSettingsBrandGlyph, createRendererSettingsIcon } from "./icons.js";
import { rendererSettingsMessages, type RendererSettingsLocale } from "./localization.js";
import dialogCss from "./release-announcement-dialog.css";

export const RELEASE_ANNOUNCEMENT_DIALOG_ATTRIBUTE = "data-codexhost-release-announcement-dialog";

const INLINE_CODE_PATTERN = /(`+)((?:(?!\1).)+)\1/gu;

export interface SelectedReleaseAnnouncementContent {
  readonly language: "zh" | "en";
  readonly content: ReleaseAnnouncementContent;
}

export interface ReleaseAnnouncementDialogOptions {
  readonly announcement: ReleaseAnnouncement;
  readonly locale: RendererSettingsLocale;
  readonly ownerDocument?: Document;
  readonly colorScheme?: "light" | "dark" | "inherit";
  /** Fires once when the user dismisses the dialog via the button or Escape. */
  onClose?(): void;
}

export interface ReleaseAnnouncementDialogHandle {
  readonly root: HTMLElement;
  readonly dialog: HTMLDialogElement;
  setColorScheme(colorScheme: "light" | "dark" | "inherit"): void;
  close(): void;
  /** Removes the dialog without invoking `onClose`. */
  dispose(): void;
}

/** Pick the announcement matching the UI locale, falling back to the other language when absent. */
export function selectReleaseAnnouncementContent(
  announcement: ReleaseAnnouncement,
  locale: RendererSettingsLocale,
): SelectedReleaseAnnouncementContent | null {
  if (locale === "zh-CN") {
    if (announcement.zh) return { language: "zh", content: announcement.zh };
    if (announcement.en) return { language: "en", content: announcement.en };
    return null;
  }
  if (announcement.en) return { language: "en", content: announcement.en };
  if (announcement.zh) return { language: "zh", content: announcement.zh };
  return null;
}

/** Format an ISO publication timestamp into a localized calendar date. */
export function formatReleaseAnnouncementDate(
  publishedAt: string,
  locale: RendererSettingsLocale,
  timeZone?: string,
): string {
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const tag = locale === "zh-CN" ? "zh-CN" : "en-US";
    return new Intl.DateTimeFormat(tag, {
      year: "numeric",
      month: "long",
      day: "numeric",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return publishedAt.slice(0, 10);
  }
}

/** Format contributor handles as `name · name`, stripping any leading `@`. */
export function formatReleaseAnnouncementContributors(contributors: readonly string[]): string {
  const formatted: string[] = [];
  for (const raw of contributors) {
    const name = raw.trim().replace(/^@+/u, "");
    if (name.length > 0) formatted.push(name);
  }
  return formatted.join(" · ");
}

function appendInlineCode(ownerDocument: Document, parent: HTMLElement, text: string): void {
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parent.append(text.slice(lastIndex, index));
    const code = ownerDocument.createElement("code");
    code.textContent = match[2] ?? "";
    parent.append(code);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parent.append(text.slice(lastIndex));
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Mount and open the release announcement modal in an isolated top-layer Shadow DOM. */
export function openReleaseAnnouncementDialog(
  options: ReleaseAnnouncementDialogOptions,
): ReleaseAnnouncementDialogHandle | null {
  const ownerDocument = options.ownerDocument ?? document;
  if (!ownerDocument.body) return null;

  const selected = selectReleaseAnnouncementContent(options.announcement, options.locale);
  if (!selected) return null;

  const existing = ownerDocument.querySelector(`[${RELEASE_ANNOUNCEMENT_DIALOG_ATTRIBUTE}]`);
  if (existing) existing.remove();

  const messages = rendererSettingsMessages(options.locale);
  const versionLabel = `v${options.announcement.version}`;
  const publishedDate = formatReleaseAnnouncementDate(
    options.announcement.publishedAt,
    options.locale,
  );
  const { content } = selected;

  const root = ownerDocument.createElement("div");
  root.setAttribute(RELEASE_ANNOUNCEMENT_DIALOG_ATTRIBUTE, "v1");
  root.lang = options.locale;
  root.style.colorScheme = options.colorScheme ?? "inherit";

  const shadow = root.attachShadow({ mode: "open" });
  const style = ownerDocument.createElement("style");
  style.textContent = dialogCss;

  const dialog = ownerDocument.createElement("dialog");
  dialog.className = "release-announcement-dialog";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-modal", "true");

  const createVersionBadge = (extraClassName?: string): HTMLElement => {
    const badge = ownerDocument.createElement("span");
    badge.className = extraClassName
      ? `release-announcement__version-badge ${extraClassName}`
      : "release-announcement__version-badge";
    const glyph = createRendererSettingsBrandGlyph(14);
    const label = ownerDocument.createElement("span");
    label.textContent = versionLabel;
    badge.append(glyph, label);
    return badge;
  };

  const titleId = "codexhost-release-announcement-title";
  const header = ownerDocument.createElement("header");
  header.className = "release-announcement__header";
  const title = ownerDocument.createElement("h2");
  title.className = "release-announcement__title";
  title.id = titleId;
  title.textContent = messages.releaseAnnouncement.title;
  dialog.setAttribute("aria-labelledby", titleId);
  const headerBadge = createVersionBadge("release-announcement__header-badge");
  header.append(title, headerBadge);

  const body = ownerDocument.createElement("div");
  body.className = "release-announcement__body";
  body.lang = selected.language === "zh" ? "zh-CN" : "en";

  const intro = ownerDocument.createElement("div");
  intro.className = "release-announcement__intro";
  const meta = ownerDocument.createElement("div");
  meta.className = "release-announcement__meta";
  meta.append(createVersionBadge());
  if (publishedDate) {
    const dateElement = ownerDocument.createElement("time");
    dateElement.className = "release-announcement__date";
    dateElement.dateTime = options.announcement.publishedAt;
    dateElement.textContent = publishedDate;
    meta.append(dateElement);
  }
  intro.append(meta);
  if (content.summary) {
    const summary = ownerDocument.createElement("p");
    summary.className = "release-announcement__summary";
    appendInlineCode(ownerDocument, summary, content.summary);
    intro.append(summary);
  }
  body.append(intro);

  const themes = ownerDocument.createElement("div");
  themes.className = "release-announcement__themes";
  for (const theme of content.themes) {
    const card = ownerDocument.createElement("article");
    card.className = "release-announcement__theme";

    const themeHeader = ownerDocument.createElement("div");
    themeHeader.className = "release-announcement__theme-header";

    const heading = ownerDocument.createElement("div");
    heading.className = "release-announcement__theme-heading";
    if (theme.icon) {
      const icon = ownerDocument.createElement("span");
      icon.className = "release-announcement__theme-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = theme.icon;
      heading.append(icon);
    }
    const themeTitle = ownerDocument.createElement("h3");
    themeTitle.className = "release-announcement__theme-title";
    themeTitle.textContent = theme.title;
    heading.append(themeTitle);
    themeHeader.append(heading);

    const contributorsText = formatReleaseAnnouncementContributors(theme.contributors);
    if (contributorsText) {
      const contributors = ownerDocument.createElement("span");
      contributors.className = "release-announcement__theme-contributors";
      contributors.textContent = contributorsText;
      themeHeader.append(contributors);
    }

    const themeBody = ownerDocument.createElement("p");
    themeBody.className = "release-announcement__theme-body";
    appendInlineCode(ownerDocument, themeBody, theme.body);

    card.append(themeHeader, themeBody);
    themes.append(card);
  }
  body.append(themes);

  if (isSafeHttpsUrl(options.announcement.url)) {
    const more = ownerDocument.createElement("div");
    more.className = "release-announcement__more";
    const fullLink = ownerDocument.createElement("a");
    fullLink.className = "release-announcement__full-link";
    fullLink.href = options.announcement.url;
    fullLink.target = "_blank";
    fullLink.rel = "noopener noreferrer";
    fullLink.append(
      messages.releaseAnnouncement.fullNotes,
      createRendererSettingsIcon("external-link", 13),
    );
    more.append(fullLink);
    body.append(more);
  }

  const footer = ownerDocument.createElement("footer");
  footer.className = "release-announcement__footer";

  const acknowledgeButton = ownerDocument.createElement("button");
  acknowledgeButton.type = "button";
  acknowledgeButton.className = "release-announcement__acknowledge";
  acknowledgeButton.textContent = messages.releaseAnnouncement.acknowledge;
  footer.append(acknowledgeButton);

  dialog.append(header, body, footer);
  shadow.append(style, dialog);

  let closed = false;
  const finish = (notifyUserClose: boolean): void => {
    if (closed) return;
    closed = true;
    ownerDocument.removeEventListener("keydown", onDocumentKeyDown, true);
    if (dialog.open) {
      try {
        dialog.close();
      } catch {
        // Ignore if already detached or in an environment without showModal.
      }
    }
    root.remove();
    if (notifyUserClose) options.onClose?.();
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish(true);
  };

  acknowledgeButton.addEventListener("click", () => finish(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(true);
  });
  dialog.addEventListener("close", () => finish(true));
  ownerDocument.addEventListener("keydown", onDocumentKeyDown, true);

  ownerDocument.body.append(root);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
  dialog.focus({ preventScroll: true });

  return {
    root,
    dialog,
    setColorScheme(colorScheme) {
      root.style.colorScheme = colorScheme;
    },
    close() {
      finish(true);
    },
    dispose() {
      finish(false);
    },
  };
}
