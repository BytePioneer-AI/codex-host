import { IconLinkOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./WebExtensionsSection.module.css";

/** A package without a public project address has no external-link action. */
export function ExtensionProjectLink({
  url,
  t,
}: PropsLocale<"codexhostImport"> & { url: string | undefined }) {
  if (url === undefined) return null;
  const github = new URL(url).hostname === "github.com";
  return (
    <a
      className={css.iconButton}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={github ? "GitHub" : t("extensions.project")}
      title={url}
      data-extension-project={github ? "github" : "web"}
    >
      {github ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.77 10.77 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" />
        </svg>
      ) : (
        <IconLinkOutlineRegular size={18} />
      )}
    </a>
  );
}
