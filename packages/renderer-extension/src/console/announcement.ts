import { consoleAnnouncementSchema } from "@codexhost/shared-contracts";

import { createRendererSettingsIcon } from "../settings/icons.js";
import { createReleaseNotesElement } from "../settings/release-notes.js";
import { consoleGet } from "./api.js";
import { h } from "./dom.js";

/** Fetch once on page load; failures stay invisible and never trigger retries. */
export async function mountConsoleAnnouncement(container: HTMLElement): Promise<void> {
  const payload = await consoleGet<unknown>("/api/announcement", AbortSignal.timeout(8_000)).catch(
    () => null,
  );
  const announcement = consoleAnnouncementSchema.safeParse(payload).data;
  if (!announcement) return;
  const document = container.ownerDocument;
  container.setAttribute("aria-label", announcement.title);
  container.dataset.type = announcement.type;
  container.replaceChildren(
    createRendererSettingsIcon(announcement.type === "info" ? "info" : "alert", 18),
    h(
      document,
      "div",
      {},
      h(document, "strong", {}, announcement.title),
      createReleaseNotesElement(document, announcement.body),
    ),
  );
  container.hidden = false;
}
