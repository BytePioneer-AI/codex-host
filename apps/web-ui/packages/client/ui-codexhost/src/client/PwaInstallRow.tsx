/** General Settings entry for browser installation and platform-specific help. */
import { useId, useState, useSyncExternalStore } from "react";
import {
  IconChevronDownOutlineRegular,
  IconDownloadOutlineRegular,
  IconRightUpOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { PwaInstall } from "@deepseek-ai/dsh-client-web";
import { ANDROID_APK_RELEASES_URL } from "./MobileGuideCard.tsx";
import css from "./PwaInstallRow.module.css";

export interface PwaInstallFace {
  installation: PwaInstall;
}

export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __CODEXHOST_DESKTOP_SHELL__?: boolean }).__CODEXHOST_DESKTOP_SHELL__ === true
  );
}

export function PwaInstallRow({
  installation,
  t,
}: PropsRuntime<"settings.general.item"> & PropsLocale<"codexhostImport"> & PwaInstallFace) {
  const state = useSyncExternalStore(installation.store.subscribe, installation.store.getSnapshot);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideId = useId();
  const descriptionId = useId();

  if (isDesktopShell()) return null;

  const nativePrompt = state === "available" || state === "prompting";
  const summaryKey =
    installation.guide === "ios"
      ? "pwa.summary.ios"
      : installation.guide === "android"
        ? "pwa.summary.android"
        : "pwa.summary.browser";
  const description =
    installation.guide === "insecure" && state !== "installed"
      ? t("pwa.guide.insecure")
      : state === "manual" || state === "available"
        ? t(summaryKey)
        : t(`pwa.${state}`);
  const buttonLabel = nativePrompt
    ? t("pwa.install")
    : t(guideOpen ? "pwa.hideInstructions" : "pwa.instructions");

  return (
    <div className={css.section}>
      <div className={css.row}>
        <div className={css.text}>
          <div className={css.title}>{t("pwa.title")}</div>
          {description !== null && (
            <div
              id={descriptionId}
              className={css.description}
              role={state === "failed" ? "alert" : "status"}
            >
              {description}
            </div>
          )}
        </div>
        {state !== "installed" && (
          <button
            type="button"
            className={css.button}
            disabled={state === "prompting"}
            aria-busy={state === "prompting"}
            aria-describedby={description === null ? undefined : descriptionId}
            aria-expanded={nativePrompt ? undefined : guideOpen}
            aria-controls={nativePrompt ? undefined : guideId}
            onClick={() => {
              if (nativePrompt) {
                setGuideOpen(false);
                void installation.install();
              } else {
                setGuideOpen((open) => !open);
              }
            }}
          >
            {nativePrompt && <IconDownloadOutlineRegular size={16} />}
            <span>{buttonLabel}</span>
            {!nativePrompt && (
              <IconChevronDownOutlineRegular
                size={14}
                className={guideOpen ? css.chevronOpen : css.chevron}
              />
            )}
          </button>
        )}
      </div>
      {guideOpen && state !== "installed" && (
        <div id={guideId} className={css.guide}>
          {installation.guide === "ios" ? (
            <ol className={css.steps}>
              <li>{t("pwa.guide.ios.step1")}</li>
              <li>{t("pwa.guide.ios.step2")}</li>
              <li>{t("pwa.guide.ios.step3")}</li>
            </ol>
          ) : installation.guide === "insecure" ? (
            <p className={css.guideLead}>{t("pwa.guide.insecure")}</p>
          ) : (
            <p className={css.guideLead}>{t(`pwa.guide.${installation.guide}`)}</p>
          )}
          {installation.guide === "android" && (
            <p className={css.apkRow}>
              <span>{t("pwa.guide.androidApk")}</span>{" "}
              <a
                className={css.link}
                href={ANDROID_APK_RELEASES_URL}
                target="_blank"
                rel="noreferrer"
              >
                <span>{t("pwa.guide.androidApkLink")}</span>
                <IconRightUpOutlineRegular size={12} />
              </a>
            </p>
          )}
          <p className={css.note}>{t("pwa.guide.limitations")}</p>
        </div>
      )}
    </div>
  );
}
