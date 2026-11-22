/** Concise Android APK and iOS Safari Home Screen guidance for mobile access. */
import { useId, useState, type ReactNode } from "react";
import {
  Button,
  IconChevronDownOutlineRegular,
  IconDownloadOutlineRegular,
  IconRightUpOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { QrCode } from "./QrCode.tsx";
import css from "./ConnectDevicesSection.module.css";

export const ANDROID_APK_RELEASES_URL =
  "https://github.com/BytePioneer-AI/codex-host/releases/latest";

export function MobileGuideCard({ t }: { t: PropsLocale<"codexhostImport">["t"] }): ReactNode {
  const [apkQrOpen, setApkQrOpen] = useState(false);
  const apkQrId = useId();
  const headingId = useId();

  return (
    <section className={css.mobileSection} aria-labelledby={headingId}>
      <div className={css.sectionHeadingRow}>
        <h3 id={headingId} className={css.sectionHeading}>
          {t("connectDevices.mobile.title")}
        </h3>
        <p className={css.meta}>{t("connectDevices.mobile.subtitle")}</p>
      </div>
      <div className={css.mobileGrid}>
        <div className={css.mobileCard} data-mobile-guide="android">
          <div className={css.mobileCardHeader}>
            <span className={css.mobileCardTitle}>{t("connectDevices.mobile.androidTitle")}</span>
            <span className={css.badge}>{t("connectDevices.mobile.androidBadge")}</span>
          </div>
          <p className={css.notice}>{t("connectDevices.mobile.androidDesc")}</p>
          <div className={css.mobileActions}>
            <a
              className={css.downloadLink}
              href={ANDROID_APK_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
            >
              <IconDownloadOutlineRegular size={15} />
              <span>{t("connectDevices.mobile.androidDownload")}</span>
              <IconRightUpOutlineRegular size={13} />
            </a>
            <Button
              variant="outline"
              aria-expanded={apkQrOpen}
              aria-controls={apkQrId}
              onClick={() => setApkQrOpen((open) => !open)}
            >
              <span>
                {t(
                  apkQrOpen
                    ? "connectDevices.mobile.hideDownloadQr"
                    : "connectDevices.mobile.showDownloadQr",
                )}
              </span>
              <IconChevronDownOutlineRegular
                size={14}
                className={apkQrOpen ? css.chevronOpen : css.chevron}
              />
            </Button>
          </div>
          {apkQrOpen && (
            <div id={apkQrId} className={css.apkQrPanel}>
              <span className={css.apkQrFrame}>
                <QrCode
                  value={ANDROID_APK_RELEASES_URL}
                  label={t("connectDevices.mobile.androidQrLabel")}
                  className={css.apkQr}
                />
              </span>
              <p className={css.meta}>{t("connectDevices.mobile.androidQrHint")}</p>
            </div>
          )}
        </div>
        <div className={css.mobileCard} data-mobile-guide="ios">
          <div className={css.mobileCardHeader}>
            <span className={css.mobileCardTitle}>{t("connectDevices.mobile.iosTitle")}</span>
            <span className={css.badge}>{t("connectDevices.mobile.iosBadge")}</span>
          </div>
          <p className={css.notice}>{t("connectDevices.mobile.iosDesc")}</p>
          <ol className={css.mobileSteps}>
            <li>{t("connectDevices.mobile.iosStep1")}</li>
            <li>{t("connectDevices.mobile.iosStep2")}</li>
            <li>{t("connectDevices.mobile.iosStep3")}</li>
          </ol>
        </div>
      </div>
    </section>
  );
}
